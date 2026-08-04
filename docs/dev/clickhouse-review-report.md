# ClickHouse 改造代码评审与性能分析报告

## 1. 业务流程与数据全链路分析

在引入 ClickHouse 之前，系统的数据链路为：
**Agent / 采集端** -> `BatchBuffer` (内存聚合) -> `SQLite` (全量写入与查询)。
在此模型下，所有高频的分钟级、小时级聚合数据（`minute_dim_stats`, `domain_stats` 等）均在 SQLite 中进行 UPSERT 操作。虽然在 `main` 分支后期已经引入了 `BatchBuffer` 内存批处理并在 SQLite 中启用了 `WAL` 模式与 `synchronous = NORMAL` 来降低写盘频率，但在面对极其庞大的并发连接数与海量分析查询时，SQLite 的读写锁竞争（读者阻塞写者或写者阻塞读者）仍然会导致性能瓶颈，尤其是管理面板进行复杂的多维度关联查询（如 `getDomainStatsPaginated`, `getRuleChainFlow`）时会消耗大量磁盘 I/O 和 CPU。

**引入 ClickHouse 后的新链路：**
**Agent / 采集端** -> `BatchBuffer` -> **双写路由**：
1. **持久化与实时状态 (SQLite)**：仍然写入 SQLite，保障系统无缝降级与核心关系型状态存在。
2. **海量分析数据存储 (ClickHouse)**：通过 `ClickHouseWriter` 异步缓冲并批量写入 ClickHouse（`traffic_minute` 和 `country_minute` 表）。

**查询链路改造 (`StatsService`)**：
实现了读写分离。所有的厚重统计或大范围时间范围的查询通过 `StatsService.shouldUseClickHouse()` 判断，将读请求路由至 `ClickHouseReader`，由 ClickHouse 这类具有强力 MPP 架构的列式数据库承担聚合（SummingMergeTree）与过滤计算，并与 `RealtimeStore` 中的最新分钟内存数据进行合并（Merge）。这极大解放了 SQLite 的读压力。

## 2. 性能提升分析（缓解硬盘 I/O 问题）

**通过本次改造，确实能够显著缓解原先 SQLite 的硬盘 I/O 读盘过多及锁竞争问题：**
1. **读写分离**：最消耗 I/O 的是管理界面的数据分析图表（如几十万行的流量表聚合）。将其转移至 ClickHouse 查询，使得 SQLite 的核心任务变成了单一的追加更新，不再因为大量的随机读查询导致 Page Cache 频繁换页和磁盘暴增。
2. **聚合机制的改变**：ClickHouse 使用了 `SummingMergeTree` 引擎。对于分析型数据，ClickHouse 通过后台 `Merge` 异步聚合 `upload`, `download`, `connections` 数据，而非像 SQLite 在每次 Insert 时执行高昂的 `ON CONFLICT DO UPDATE` B-Tree 更新。
3. **批量插入容错**：`ClickHouseWriter` 实现了严格的队列管控（`maxPendingBatches`），并在满载时丢弃旧批次记录至 `metrics.failures`，这是非常科学的监控系统降级策略，能在遭遇极其严重的 I/O 风暴时保护 Node.js 主进程不因 OOM 崩溃。

## 3. 具体源码 Review 与潜在优化点

### 3.1 优秀设计
- **ClickHouseWriter 的任务链式控制**：使用了基于 `Promise.then` 的 `writeChain` 进行串行批量写入，并在队列堆积超过 `maxPendingBatches` 时主动丢弃数据。避免了并发 POST 请求压垮下游。
- **Realtime 实时补偿**：虽然查询走 ClickHouse，但依然使用 `includeRealtime` 和 `realtimeStore` 补偿最新一分钟的数据延迟，巧妙地规避了 ClickHouse 即时查询能力相对较弱的缺点。
- **降级与容灾容错**：`StatsService` 中实现了自动 Fallback。当 ClickHouse `CH_STRICT_STATS` 没开启时，ClickHouse 若查询失败会降级到 SQLite（通过捕获或空值兜底）。

### 3.2 潜在隐患与可优化点（依据最新复核更新）

在详细审查代码后，发现了以下几个细节可以进一步优化与加固：

1. **路由结果合并产生的非原子回退 (StatsService)**：[中优先度修复]
   在 `getSummaryWithRouting` 并发查询多个 ClickHouse 指标时，当前代码是逐项执行 `|| this.db.get...`：
   ```typescript
   const summary = summaryCH || this.db.getSummary(...);
   const dbTopDomains = topDomainsCH || this.db.getTopDomainsLight(...);
   ```
   如果中间某个 ClickHouse 并发请求（如 topDomainsCH）因为偶发的超时返回 null，它会立即单点 Fallback 到读 SQLite。由于 SQLite 和 ClickHouse 是异步落库的，这会导致在同一个 Dashboard 上展示的汇总数据（使用 ClickHouse 的值）和下方的 Top 列表（使用 SQLite 的值）出现时间窗口上的数据不一致。建议改为**原子回退**（如果任一 ClickHouse 关键查询失败，则整体降级为使用 SQLite 数据）。

2. **双写造成的 SQLite 写放大 (BatchBuffer)**：[中优先度修复]
   **问题表现**：虽然 ClickHouse 承担了查询，当前的 `BatchBuffer` 依旧会将全部监控流水全量写往 SQLite 的几十张表中（如 `minute_dim_stats` 等）。SQLite 的写放大和 I/O 更新依然存在。
   **建议**：在确保 ClickHouse 稳定的前提下，可以**有条件地减少 SQLite 写负载**（例如关闭对部分高频明细分析表的 SQLite UPSERT）。**注意**：目前不建议一刀切彻底关闭 SQLite 统计写入（不宜直接做全局 CH_ONLY_MODE），因为例如当 `timeRange.active=false` 时，默认路由依然会读取 SQLite `getSummary`，若彻底停写 SQLite 会引发功能回退与数据缺失。

3. **ClickHouseWriter 的内存压力风险 (非内存泄漏)**：[低优先度关注]
   在 `clickhouse-writer.ts` 中，数据被压入 `writeChain` 队列。虽然代码中已通过 `maxPendingBatches`（默认 200）设定了内存堆积上限，并不会导致无限增长（即不算内存泄漏）。但在极端大批次数据到来且下游 ClickHouse 卡顿时，200 个满载 Batch 驻留中仍会给 V8 引擎带来可观的内存堆积压力。

4. **ClickHouse 查询的参数化加固 (ClickHouseReader)**：[低优先度关注]
   在 `clickhouse-reader.ts` 中，字符串拼接目前使用了简单的 `this.esc` 进行单引号转义，这在大多数场景下能够防注入。但为了获得绝对的稳定与防误截断能力，长远看更为稳妥的方案是引入 ClickHouse 官方的**参数化查询 (Parameterized Queries)**，将其作为后续代码加固的一个防线。

## 4. 结论与总结

本次向 ClickHouse 的技术栈扩展是非常成功的重构。它架构清晰地完成了：
- **流量路由分离**：通过 `StatsService` 的中间层拦截。
- **高并发写入优化**：利用了 ClickHouse 的批量与合并树能力。
- **历史瓶颈解放**：极大地减轻了管理面板刷新的延迟。

**实施建议**：可以在近期版本上线。后续的演进建议按优先级处理：首要修复 `getSummaryWithRouting` 的非原子回退导致的页面数据不一致，随后在保障默认查询可用性的前提下，逐步有条件地精简 SQLite 的冗余双写，以彻底追求极致的 I/O 解放。代码整体结构严谨，无明显的语法与业务流阻断错误。
