# refactor/clickhouse 分支综合 Review 报告

> 日期：2026-02-22
> 基准：`refactor/clickhouse` vs `main`
> 变更规模：75 文件，+9571 / -2266 行，19 次提交

---

## 一、新增功能总览

### 1. ClickHouse 双写 + 读路由（核心改造）
- `BatchBuffer.flush()` 同时写入 SQLite 和 ClickHouse（`traffic_detail_buffer` / `traffic_agg_buffer` / `country_buffer`）
- `StatsService` 根据 `timeRange` 和 `STATS_QUERY_SOURCE` 动态路由读请求
- `RealtimeStore` 保持 180 分钟内存缓存，补偿 ClickHouse Buffer 延迟
- `CH_ONLY_MODE=1` 可选择完全跳过 SQLite 统计写入

### 2. Agent 模式系统性强化
- 进程锁（PID Lock）：防止同一 `backendId` 多实例
- Config Sync 循环（2 分钟）：MD5 去重推送 rules/proxies/providers
- Policy State Sync 循环（30 秒）：同步当前选中代理（`now` 字段），还原 rule flow 链路
- Backend Token 直接存储（替代 boolean 标志）
- 多 backend 一键安装支持

### 3. Surge 数据接入
- `surge.collector.ts` 轮询 Surge HTTP API
- `gateway/config.go` 实现 Surge 规则/代理配置拉取

### 4. React Flow 节点优化
- `DIRECT` 策略引入独立节点类型、专属样式和布局

### 5. 代码模块化重构
- 从平铺 `src/` 迁移至 `src/modules/`（每模块含 `index.ts` 入口）

---

## 二、ClickHouse 性能分析

| 指标 | SQLite (main) | ClickHouse (本分支) |
|---|---|---|
| 写放大 | 每次 flush 跨 17 张表 UPSERT，B-Tree 随机写 | Buffer 表 Append-Only，后台异步合并 |
| 读压力 | Top 100 domains 全表扫描 | 列存 + SummingMergeTree，MPP 聚合 |
| 并发锁 | 读写锁导致管理面板阻塞采集 | 读写完全分离 |
| 实时性 | 无延迟 | Buffer 最长 5 分钟，由 RealtimeStore 补偿 |

---

## 三、问题清单（按优先级）

### P0 — 必须修复

#### P0-1：`isEnabled()` 静态判断，CH 宕机时 SQLite 写入被错误跳过

- **文件**：`apps/collector/src/modules/clickhouse/clickhouse.writer.ts:58-60`
- **调用方**：`apps/collector/src/modules/collector/batch-buffer.ts:111-112`

`isEnabled()` 在构造时一次性计算，之后永不更新。若运行时 ClickHouse 容器崩溃，`isEnabled()` 仍返回 `true`，导致 `shouldSkipSqliteStatsWrites()` 决定跳过 SQLite 写入，同时 ClickHouseWriter 队列满而丢弃数据，造成 **数据双丢失**。

**修复方案**：在 `ClickHouseWriter` 中追踪运行时连续失败次数，暴露 `isHealthy()` 方法（`isEnabled() && consecutiveFailures < threshold`），`batch-buffer.ts` 改为调用 `isHealthy()`。

#### P0-2：`nekoagent stop` 只等 1 秒，Agent 优雅停机被截断

- **文件**：`apps/agent/nekoagent:326-330`
- **关联**：`apps/agent/internal/agent/runner.go:173-177`（优雅停机有 10 秒 timeout）

`nekoagent stop` 发 SIGTERM 后 `sleep 1` 即 SIGKILL。Agent 的 `flushOnce` 需要最多 10 秒完成最后一批数据上报，1 秒后被强杀导致丢失最后一批流量数据。

**修复方案**：`sleep 1` 改为 `sleep 12`（10 秒超时 + 2 秒余量）。

---

### P1 — 强烈建议修复

#### P1-1：Reader 的 SQL 通过 URL query 参数传输，长查询可能超限

- **文件**：`apps/collector/src/modules/clickhouse/clickhouse.reader.ts:1203`

复杂查询（如 `getRuleChainFlowAll`，80+ 行 SQL）放入 URL query 参数，可能超过 Nginx/ClickHouse 的 URL 长度限制（默认 8-16KB）。

**修复方案**：`query()` 方法改为 `method: 'POST'`，将 SQL 放入 request body。

#### P1-2：`toDateTime` 无效时返回 epoch，可能导致全表扫描

- **文件**：`apps/collector/src/modules/clickhouse/clickhouse.reader.ts:1228-1234`

当 start/end 日期无效时，`WHERE minute >= '1970-01-01 00:00:00'` 扫描所有历史数据，可能导致超时或 OOM。

**修复方案**：`toDateTime` 无效时返回 `null`，上层在 `null` 时跳过查询。

#### P1-3：路由指标数据被收集但日志输出被注释，运维盲点

- **文件**：`apps/collector/src/modules/stats/stats.service.ts:137`

`routeMetrics` Map 持续累加计数但 `console.info` 被注释掉（`// Stats route metrics logging removed`）。运维时无法观察 CH vs SQLite 路由分布。

**修复方案**：恢复日志输出语句。

#### P1-4：`syncPolicyState` 无去重，每 30 秒无条件 POST

- **文件**：`apps/agent/internal/agent/runner.go:356-375`

与 `syncConfig`（有 MD5 hash 对比）不同，`syncPolicyState` 每次都无条件发送，即使策略未变。

**修复方案**：增加 `lastPolicyHash` 字段，marshal 快照后计算 MD5，相同则跳过 POST。

---

### P2 — 后续迭代

#### P2-1：`install.sh` 第 332 行参数拼接依赖 word splitting

- **文件**：`apps/agent/install.sh:332-333`

```sh
$(if [ -n "$NEKO_GATEWAY_TOKEN" ]; then echo "--gateway-token $NEKO_GATEWAY_TOKEN"; fi) \
```

Token 含空格时（虽然实际 base64url 不含）参数会被错误分割。同文件其他地方已正确使用 `set --` 模式。

**修复方案**：改用 `set --` 逐步追加参数（第 127-133 行的 `use_local_agent` 已示范）。

#### P2-2：`detect_existing_install` 被执行两次

- **文件**：`apps/agent/install.sh:196-198`

```sh
if detect_existing_install; then
  existing_agent="$(detect_existing_install)"  # 重复执行
fi
```

**修复方案**：合并为 `if existing_agent="$(detect_existing_install)"; then`。

#### P2-3：`cmd_update` 下载远程脚本无 hash 验证

- **文件**：`apps/agent/nekoagent:389-412`

更新时下载 `main` 分支的 install.sh 并直接执行，未做签名验证。

---

### P3 — 代码质量

| 编号 | 问题 | 位置 |
|---|---|---|
| P3-1 | `batchUpdateTrafficStats` 每次 flush 重新 prepare 语句 | `traffic-writer.repository.ts:351` |
| P3-2 | `domainKey` 包含 IP 降低聚合效率，增加 UPSERT 次数 | `traffic-writer.repository.ts:241` |
| P3-3 | `esc()` 未处理所有 ClickHouse 特殊字符（建议改参数化查询） | `clickhouse.reader.ts:1254` |
| P3-4 | `syncConfig` 409 判断用字符串匹配（脆弱）| `runner.go:268` |
| P3-5 | `ipProxyDomainStmt` 的 N×M 写入模式 | `traffic-writer.repository.ts:512-516` |

---

## 四、Docker 用户升级路径

### 向后兼容性：完全兼容

所有 CH 环境变量默认关闭，现有用户 `docker compose up -d` 无需任何配置更改。

### 启用 ClickHouse 的推荐步骤

```bash
# 阶段 1：双写试运行（保持 SQLite 读，观察 1 周）
CH_ENABLED=1 CH_WRITE_ENABLED=1 STATS_QUERY_SOURCE=sqlite \
  docker compose --profile clickhouse up -d

# 阶段 2：迁移历史数据
./scripts/ch-migrate-docker.sh

# 阶段 3：切换读路由
STATS_QUERY_SOURCE=auto docker compose up -d

# 阶段 4（可选）：弃用 SQLite 统计写入
CH_ONLY_MODE=1 CH_REQUIRED=1 docker compose up -d
```

### 弃用 SQLite 的前提条件

1. ClickHouse 容器已配置持久化存储（volume）
2. 设置 `CH_REQUIRED=1`（CH 不可用时拒绝启动，而非静默丢数据）
3. 了解 P0-1 问题的风险（修复后可更安全地启用）
4. rule chain flow 等端点仍依赖 SQLite，不受影响

---

## 五、文档缺口

| 缺口 | 说明 |
|---|---|
| ClickHouse 环境变量索引 | README 缺少所有 `CH_*` 变量的完整说明 |
| `--profile clickhouse` 快速启动 | README 快速开始章节未提及 |
| `CH_ONLY_MODE` 风险提示 | 无文档说明 CH 不可用时的后果 |
| ClickHouse 数据备份方案 | 无 volume snapshot 或 clickhouse-backup 说明 |
| Agent systemd 服务化 | 非 Docker 用户如何开机自启 |
| Surge gateway 配置 | README Agent 章节未说明 `--gateway-type surge` |
