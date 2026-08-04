# ClickHouse 迁移：数据流与 I/O 性能深度分析报告

> 分析基准：当前分支 (`clickhouse` 相关改造) vs `main` 分支
> 报告参考：已有的 `clickhouse-dataflow-analysis.md` 和 `clickhouse-review-report.md` 分析报告

本报告聚焦于引入 ClickHouse 以来的数据流架构变更，特别是针对降低硬盘 I/O 读写的重构效果进行深入评估，并指出现有设计中存在的几处严重架构隐患（尤其实在异常降级与一致性保障方面）。

---

## 1. 业务数据流梳理 (源头 -> 处理 -> 存储 -> 缓存)

相比于 `main` 分支单纯依赖 SQLite 和内存的模式，当前版本的数据流变更为更为复杂的双写+读写分离架构：

1. **数据源头 (采集层)**：
   - 依赖 `GatewayCollector` 通过 WebSocket 持续对接 Clash/Neko 核心，增量计算后的流量 (`TrafficUpdate`) 和 IP 信息进入内存处理环节。此过程纯内存操作，无 I/O 开销。

2. **处理层 (内存缓冲)**：
   - 引入了 `BatchBuffer` (分钟级聚合器)。所有零散请求按 (domain, ip, chain, rule) 多维度 Tuple 进行本地 Map 聚合。
   - 积累一定时间（约30s）或数量（5000条）后，统一 `flush()` 到下游数据库。极大降低了后续的 TPS 和 B-Tree 索引压力。

3. **双写存储层 (核心改造区)**：
   - **ClickHouse (分析库)**：新增 `ClickHouseWriter`，利用 HTTP 批量插入到 `_buffer` 表，最后通过后台异步写入 `SummingMergeTree`。
   - **SQLite (主存库)**：保留 SQLite，但引入了 **`reduceWrites` (削减写入)** 机制。当判定 CH 启用时，SQLite 丢弃了绝大部分明细表和多维关联表的 UPSERT。

4. **缓存与路由查询层**：
   - 查询统一经由 `StatsService`。该服务根据 `timeRange` 和请求类型，动态将“厚重”统计指标路由给 ClickHouse（`ClickHouseReader`）。
   - 保留的 `RealtimeStore` 将前 180 分钟的数据挂载在内存中，在 ClickHouse 数据尚未落盘 (Buffer 延迟) 的时间差内提供尾部数据的 Merge 补偿查询。

---

## 2. I/O 性能瓶颈优化评估

**结论：I/O 读写取得了极其显著的改善，架构演进大方向非常正确。**

* **写 I/O 极速下降 (Write Amplification 下降)**：
  在 `main` 分支中，每次 `BatchBuffer.flush()` 都会产生巨大的 SQLite 写放大，因为这需要跨包括 `domain_stats`, `rule_ip_traffic` 等 16 张表执行 B-Tree 的局部修改和 `WAL` 刷盘。
  在当前分支，借助 `reduceWrites=true`，SQLite 被精简到只写入 `hourly_stats` 和 `minute_stats` 等极度轻量的基础表。主要的多维流量写盘压力被顺滑地承接到 ClickHouse，CH 的列存 Append-Only 特性在吞吐量和 I/O 利用率上完胜 SQLite。

* **读 I/O 和 CPU 瓶颈解封**：
  历史版本中，管理面板的大范围 `Top 100 Domains` 排序和 `Rule Chain Flow` 会引发 SQLite 百万行级别的随机读与聚合。目前全部由 `StatsService` 移交 ClickHouse 计算，读 I/O 被完美地摊销甚至基本消除（由 CH 的高效列存+缓存完成）。

---

## 3. 架构中的“不合理”与严重隐患

在深入 Review 源码并参考另外两位专家的意见后，我注意到了几个系统级的逻辑漏洞，有些可能会导致**严重的生产数据空洞**：

### 🔴 隐患一：`reduceWrites` 与“假健康”判定导致的【数据丢失黑洞】

**代码位置**：`batch-buffer.ts` 与 `traffic-writer.repository.ts`

**现象与原理**：
代码中决定是否精简 SQLite 写入的依据是：
```typescript
const skipSqliteStatsWrites = shouldSkipSqliteStatsWrites(clickHouseWriter.isEnabled());
```
注意，`clickHouseWriter.isEnabled()` 仅仅判断了**环境变量 (`CH_WRITE_ENABLED === '1'`) 和配置**是否开启，**并未包含 ClickHouse 实例当前的实际健康状态**。
如果生产环境中 ClickHouse 容器崩溃、网络不通或长时故障，`ClickHouseWriter` 内部的任务队列写满并开始丢弃日志 (`metrics.failures++`)；但同时，因为 `isEnabled()` 仍为 true，`reduceWrites` 也仍为 true！
**致命后果**：
SQLite 依然跳过了 `domain_stats`、`ip_stats`、`minute_dim_stats` 等核心表的写入。这将导致**这段时间内，日志既没有进 CH，也没有进 SQLite**。当系统试图触发自动降级（Fallback）从 SQLite 读取时，读出来的数据将是 0 或者是残缺的（因为数据压根没存进 SQLite）。

**修复建议**：
`reduceWrites` 的开启条件必须与 ClickHouse 的运行时健康检查 (Health Check) 强绑定。若 CH 写入连续失败或队列满，应熔断短路，立即恢复全量写入 SQLite 兜底。

### 🟡 隐患二：自动降级 (Fallback) 面临“空数据”尴尬

**代码位置**：`stats.service.ts`

专家报告中提到如果 ClickHouse 挂了，系统支持向 SQLite Fallback（读取 `getSummary` 等）。
但因为如上所属 `tx1` (如 `domainMap`) 和 `tx2` 大量维度记录在 `reduceWrites = true` 时被砍掉，此时系统哪怕去查询 SQLite 的 `getDomainStatsPaginated`，获取到的往往只有老数据（开启 CH 之前遗留的），因为新流量根本没被 `INSERT/UPSERT` 到 SQLite 里！
这就意味着目前的所谓“高可用容灾读降级”，只有在极少数未被削减的表（如 `minute_stats` 和 `hourly_stats`）上才有效；对明细查询形同虚设。

### 🟢 隐患三：纠正前序报告的误判（关于 `minute_stats` 的写入）

前一份专家报告 (`clickhouse-dataflow-analysis.md`) 中指出：“`minute_stats` 和 `minute_dim_stats` 被跳过了”。
**事实纠正**：经过查阅当前 `traffic-writer.repository.ts` 的 `tx2` 最终源码，`minute_stats` 的 UPSERT 事务被放在了 `if (!reduceWrites)` 条件控制的外侧，**即使简化写入开启，它仍然会成功入库**。这是开发在后期已经修复的代码，确保了 `getTrafficInRange` 这个核心函数在 SQLite 中的可靠性。确切被裁撤的是 `minute_dim_stats` 和各类关联维度的 traffic/stats。 

### 🟡 隐患四：`StatsService` 的部分聚合与回退颗粒度太粗

目前如果在 `getSummaryWithRouting` 并发拉取 7 个 ClickHouse 查询（TopDomains, TopIPs, Rules...），只要有一个请求（如 TopIPs）偶然超时返回 null，系统判定 `!allCHReady` 成立，会强制让所有的 7 个组件一起 Fallback 回 SQLite。
如前所述，因为部分 SQLite 表缺少新数据，这会引发 Dashboard 数据突然断崖式下跌或缺失，引发用户恐慌。更合理的方式是能够利用已经查到的 CH 数据部分展示，对未拉到的模块做转菊花或单模块兜底。

---

## 4. 总结与改进步骤规划

总的来看，相比 `main` 分支，当前 `clickhouse` 版本对于降低系统整体的硬盘 IO 读写负担和突破性能天花板效果极佳。但是为了真正达成生产级别的高可用容灾，必须解决**降级链路上的数据一致性**问题。

**下一步行动建议：**
1. **熔断器引入（最高优）**：为 `BatchBuffer` 处的 `reduceSQLiteWrites` 添加一层断路器逻辑。若 `clickHouseWriter` 的待处理队列处于压满溢出状态，短时自动把 `reduceWrites` 置为 `false`。
2. **清理 SQLite 无用读逻辑**：既然 `domain_stats` 等部分表已经切断写入，应当在读端（如 `getDomainStatsPaginatedWithRouting`）中明确意识到这一点，一旦 Fallback 被触发应当在 UI 给到明确的警告提示，而不是默默地返回一个静止的老数据池。
