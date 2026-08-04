# ClickHouse 数据流架构深度分析报告

> 分析版本: 当前开发分支 vs main分支  
> 分析重点: 引入 ClickHouse 后的数据流完整链路及 IO 性能优化  
> 生成时间: 2026-02-20

---

## 一、整体数据流架构图

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    数据源头 (Data Source)                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │  Clash Gateway  │  │  Surge Gateway  │  │  Agent 模式     │  │  其他代理后端    │     │
│  │  (WebSocket)    │  │  (HTTP API)     │  │  (被动接收)      │  │                 │     │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘     │
└───────────┼────────────────────┼────────────────────┼────────────────────┼──────────────┘
            │                    │                    │                    │
            └────────────────────┴────────┬───────────┴────────────────────┘
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                  数据采集层 (Collector)                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│  │                         GatewayCollector / SurgeCollector                        │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                 │   │
│  │  │  WebSocket连接   │  │  消息解析        │  │  连接状态跟踪    │                 │   │
│  │  │  (实时流量数据)  │  │  (Delta计算)    │  │  (activeConnections Map) │        │   │
│  │  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘                 │   │
│  │           │                    │                    │                           │   │
│  │           └────────────────────┼────────────────────┘                           │   │
│  │                                ▼                                                │   │
│  │  ┌─────────────────────────────────────────────────────────────────────────┐   │   │
│  │  │                      BatchBuffer (内存批处理缓冲区)                       │   │   │
│  │  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │   │   │
│  │  │  │  buffer (Map)   │  │  geoQueue       │  │  聚合计算        │         │   │   │
│  │  │  │  按复合键去重    │  │  GeoIP结果队列   │  │  (相同键流量合并) │         │   │   │
│  │  │  │  Key: backendId │  │                 │  │                 │         │   │   │
│  │  │  │  + minute + ... │  │                 │  │                 │         │   │   │
│  │  │  └─────────────────┘  └─────────────────┘  └─────────────────┘         │   │   │
│  │  └─────────────────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              实时内存缓存层 (Realtime Cache)                              │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│  │                         RealtimeStore (单例模式)                                 │   │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌────────────┐ │   │
│  │  │ summaryByBackend │ minuteByBackend │ domainByBackend │ ipByBackend │ proxyByBackend │ │
│  │  │   (汇总)    │   (分钟桶)    │   (域名统计)  │   (IP统计)   │  (代理统计)  │ │
│  │  │  Map<number,> │  Map<number,>  │  Map<number,>  │  Map<number,>  │ Map<number,> │ │
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ └────────────┘ │   │
│  │                                                                                  │   │
│  │  内存限制: MAX_DOMAIN_ENTRIES=50K, MAX_IP_ENTRIES=50K, MAX_RULE_CHAIN_ENTRIES=50K │   │
│  │  保留策略: maxMinutes=180分钟 (可配置), 定期 prune 旧数据                         │   │
│  └─────────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              数据写入层 (Write Layer) - 双写架构                          │
│  ┌─────────────────────────────────────────┐    ┌─────────────────────────────────────┐ │
│  │           SQLite (Primary)              │    │         ClickHouse (Analytics)      │ │
│  │  ┌─────────────────────────────────┐   │    │  ┌─────────────────────────────┐   │ │
│  │  │    TrafficWriterRepository      │   │    │  │      ClickHouseWriter       │   │ │
│  │  │  ┌─────────────────────────┐   │   │    │  │  ┌─────────────────────┐   │   │ │
│  │  │  │  batchUpdateTrafficStats │   │   │    │  │  │   写入队列控制        │   │   │ │
│  │  │  │  ├─ domainMap (聚合)     │   │   │    │  │  │  maxPendingBatches  │   │   │ │
│  │  │  │  ├─ ipMap (聚合)         │   │   ├───►│  │  │  maxPendingRows     │   │   │ │
│  │  │  │  ├─ chainMap (聚合)      │   │   │    │  │  │  writeChain (串行)  │   │   │ │
│  │  │  │  ├─ ruleProxyMap (聚合)  │   │   │    │  │  └─────────────────────┘   │   │ │
│  │  │  │  ├─ minuteDimMap (聚合)  │   │   │    │  │                           │   │ │
│  │  │  │  ├─ hourlyDimMap (聚合)  │   │   │    │  │  ┌─────────────────────┐   │   │ │
│  │  │  │  ├─ deviceMap (聚合)     │   │   │    │  │  │    三张目标表        │   │   │ │
│  │  │  │  │  ... 共17个聚合Map    │   │   │    │  │  │  traffic_agg_buffer │   │   │ │
│  │  │  │  │                        │   │   │    │  │  │  traffic_detail_buffer│  │   │ │
│  │  │  │  └─ 3个Transaction批量写入│   │   │    │  │  │  country_buffer     │   │   │ │
│  │  │  └─────────────────────────┘   │   │    │  │  └─────────────────────┘   │   │ │
│  │  │                                  │   │    │  │                           │   │ │
│  │  │  WAL模式 + NORMAL同步 + 内存缓存  │   │    │  │  写入方式: HTTP JSONEachRow │   │ │
│  │  │  busy_timeout=5000ms             │   │    │  │  批量大小: 动态            │   │ │
│  │  └─────────────────────────────────┘   │    │  └─────────────────────────────┘   │ │
│  │                                        │    │                                    │ │
│  │  ⚠️ 当 CH_ONLY_MODE=1 时可跳过SQLite统计写入 │    │  ⚠️ 队列满时丢弃旧批次 (防OOM)     │ │
│  │  ⚠️ reduceWrites=true 时精简SQLite写入      │    │  ⚠️ 失败时保留Realtime数据         │ │
│  └─────────────────────────────────────────┘    └─────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              数据查询层 (Query Layer) - 路由架构                          │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│  │                              StatsService                                        │   │
│  │  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │   │
│  │  │  路由决策逻辑    │───►│  shouldUseClickHouse()                    │             │   │
│  │  │                 │    │  ├─ timeRange.active?                     │             │   │
│  │  │                 │    │  ├─ STATS_QUERY_SOURCE (sqlite/clickhouse/auto) │        │   │
│  │  │                 │    │  └─ ClickHouse可用性检查                   │             │   │
│  │  └─────────────────┘    └─────────────────┘    └─────────────────┘             │   │
│  │           │                                                                      │   │
│  │           ├────────────────────┬────────────────────┐                           │   │
│  │           ▼                    ▼                    ▼                           │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                 │   │
│  │  │   SQLite Path   │  │ ClickHouse Path │  │   Fallback逻辑   │                 │   │
│  │  │  (StatsDatabase)│  │(ClickHouseReader)│  │  (CH_STRICT_STATS)│                │   │
│  │  │                 │  │                 │  │                 │                  │   │
│  │  │  ├─ 17+张统计表 │  │  ├─ 读取Buffer表 │  │  ├─ 部分失败回退 │                  │   │
│  │  │  ├─ UPSERT查询  │  │  ├─ 物化视图     │  │  ├─ 原子性检查   │                  │   │
│  │  │  ├─ 索引优化    │  │  ├─ 聚合查询     │  │  └─ SQLite兜底   │                  │   │
│  │  │  └─ 分页/排序   │  │  └─ 实时数据合并 │  │                 │                  │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘                 │   │
│  │                                                                                  │   │
│  │  ┌─────────────────────────────────────────────────────────────────────────┐   │   │
│  │  │                    Realtime数据合并 (Merger)                             │   │   │
│  │  │  查询结果 + RealtimeStore.applySummaryDelta() / mergeTopDomains()       │   │   │
│  │  │  解决ClickHouse分钟级延迟问题，提供秒级实时性                            │   │   │
│  │  └─────────────────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、各环节详细分析

### 2.1 数据源头（Data Source）

**组件**: `GatewayCollector`, `SurgeCollector`

**关键机制**:
- **WebSocket 连接**: 与 Clash/Surge 网关建立持久连接，实时接收连接数据
- **Delta 计算**: 对比 `lastUpload/lastDownload` 计算增量流量，避免重复统计
- **连接状态跟踪**: `activeConnections Map` 跟踪每个连接的最新状态，清理过期连接（5分钟超时）

**潜在问题**:
1. **连接状态内存占用**: 高并发场景下 `activeConnections` 可能占用大量内存
2. **GeoIP 查询阻塞**: 当前是同步查询 GeoIP，虽然已改为批量但仍有优化空间

---

### 2.2 数据处理（BatchBuffer）

**关键优化**:
```typescript
// 复合键去重聚合
const key = [
  backendId, minuteKey, domain, ip, chain, 
  fullChain, rule, rulePayload, sourceIP
].join(":");
```

**设计亮点**:
- **内存聚合**: 同一分钟内相同维度的流量会被合并，减少下游写入压力
- **双队列设计**: `buffer` (流量数据) + `geoQueue` (GeoIP结果)

**IO 相关优化**:
- `FLUSH_INTERVAL_MS=30000` (30秒刷新一次)
- `FLUSH_MAX_BUFFER_SIZE=5000` (达到5000条立即刷新)

---

### 2.3 存储层 - SQLite（Primary Storage）

**Schema 分析**:
共有 **22张表**，核心表包括:
- `minute_dim_stats` / `hourly_dim_stats`: 分钟/小时级事实表（最细粒度）
- `domain_stats` / `ip_stats`: 聚合统计表
- `rule_chain_traffic` / `rule_domain_traffic`: 规则关联表
- `device_stats`: 设备统计

**IO 优化措施**:
```typescript
// db.ts 中的初始化配置
this.db.pragma('journal_mode = WAL');        // WAL模式，读写不阻塞
this.db.pragma('synchronous = NORMAL');      // 降低同步频率
this.db.pragma('wal_autocheckpoint = 1000'); // 控制WAL文件大小
this.db.pragma('temp_store = MEMORY');       // 临时表放内存
this.db.pragma('cache_size = -65536');       // 64MB缓存
this.db.pragma('busy_timeout = 5000');       // 5秒超时
```

**批量写入策略** (`TrafficWriterRepository`):
```typescript
// 内存预聚合：17个 Map 进行维度聚合
const domainMap = new Map();
const ipMap = new Map();
const chainMap = new Map();
// ... 等等

// 3个子事务批量写入
tx1(); // Core aggregation tables
tx2(); // Detail tables + minute/hourly tables  
tx3(); // Device tables (条件执行)
```

**reduceWrites 模式**:
当 ClickHouse 启用时，可以通过 `reduceWrites=true` 精简 SQLite 写入:
- **保留**: `hourly_stats`, `proxy_stats`（轻量级）
- **跳过**: `domain_stats`, `ip_stats`, `rule_*_traffic` 等详细表

---

### 2.4 存储层 - ClickHouse（Analytics Storage）

**表结构设计**:

| 表名 | 引擎 | 用途 | 分区策略 |
|------|------|------|----------|
| `traffic_agg` | SummingMergeTree | 汇总/趋势/小时查询 | toYYYYMM(minute) |
| `traffic_detail` | MergeTree | Top-N/过滤/规则链查询 | toYYYYMM(minute) |
| `country_minute` | SummingMergeTree | 国家统计 | toYYYYMM(minute) |
| `*_buffer` | Buffer | 内存缓冲表 | - |

**Buffer 表配置** (关键IO优化):
```sql
ENGINE = Buffer(
  'mihomo_orbit', 'traffic_agg', 4,  -- 4层并发
  10, 60,    -- min/max 时间: 10-60秒
  100, 10000, -- min/max 行数: 100-10000
  10000, 1000000 -- min/max 字节: 10KB-1MB
)
```

**Buffer 表的作用**:
- 将 INSERT 频率从 ~40次/分钟 降低到 ~2次/分钟
- 大幅减少 ClickHouse 后台 Merge 操作的 I/O 压力
- 数据先写入内存，满足条件后自动刷盘

---

### 2.5 查询路由层（StatsService）

**路由决策逻辑**:
```typescript
private shouldUseClickHouse(timeRange: TimeRange): boolean {
  return (
    timeRange.active &&                              // 必须激活时间范围
    this.clickHouseReader.shouldUseForRange(start, end)  // CH可用且范围有效
  );
}
```

**Fallback 策略**:
```typescript
// getSummaryWithRouting 中的原子性检查
const allCHReady = !!summaryCH && !!topDomainsCH && ...;
if (!allCHReady) {
  // 任一查询失败则整体回退到 SQLite
  return this.getSummary(backendId, timeRange);
}
```

**路由指标统计**:
- 通过 `recordRoute()` 记录每个请求的路由去向
- 日志输出: `summary=ch:100,sqlite:10,ch_rate:90.9%`

---

### 2.6 实时缓存层（RealtimeStore）

**内存结构**:
```typescript
summaryByBackend: Map<number, SummaryDelta>
minuteByBackend: Map<number, Map<string, MinuteBucket>>
domainByBackend: Map<number, Map<string, DomainDelta>>
// ... 共10+个Map
```

**关键机制**:
- **写入**: 每次流量更新实时写入内存
- **读取合并**: 查询时将 DB 结果与内存数据合并
- **清理**: `pruneOldBuckets()` 定期清理过期数据（默认保留180分钟）

**内存上限保护**:
```typescript
private static readonly MAX_DOMAIN_ENTRIES = 50_000;
private static readonly MAX_IP_ENTRIES = 50_000;
```

---

## 三、IO 性能优化点深度分析

### 3.1 ✅ 已实施的优秀优化

| 优化点 | 位置 | 效果 |
|--------|------|------|
| WAL + NORMAL 模式 | `db.ts:136-137` | 读写不阻塞，降低 fsync 频率 |
| 内存缓存配置 | `db.ts:140` | 64MB SQLite 缓存 |
| BatchBuffer 内存聚合 | `batch-buffer.ts:59-89` | 减少重复写入 |
| TrafficWriter 批量写入 | `traffic-writer.ts:188-348` | 单事务处理多条记录 |
| reduceWrites 模式 | `traffic-writer.ts:420-442` | CH启用时精简SQLite写入 |
| Buffer 表缓冲 | `clickhouse.config.ts:265-301` | 降低CH写入频率 |
| 串行写入队列 | `clickhouse-writer.ts:46-175` | 防止并发压垮下游 |
| RealtimeStore 内存缓存 | `realtime.store.ts` | 减少查询IO |

### 3.2 ⚠️ 潜在 IO 性能风险

#### 风险1: SQLite 双写仍造成写放大

**问题描述**:
虽然 ClickHouse 承担了查询，但 `BatchBuffer.flush()` 仍然会将全部数据写入 SQLite 的 17+ 张表。即使启用了 `reduceWrites`，仍然需要写入：
- `hourly_stats`
- `proxy_stats`
- `minute_stats`
- `minute_dim_stats`
- `hourly_dim_stats`
- 设备相关表（条件）

**代码位置**: `traffic-writer.ts:420-553`

**影响**: 高频写入时，WAL 文件可能快速增长，checkpoint 压力增大

**建议优化**:
1. **渐进式降级**: 当 ClickHouse 稳定运行后，完全关闭 SQLite 统计表写入
2. **WAL 文件监控**: 添加 WAL 文件大小监控和告警

---

#### 风险2: ClickHouse Buffer 表配置可能不够激进

**当前配置**:
```sql
ENGINE = Buffer(..., 10, 60, 100, 10000, 10000, 1000000)
```

**分析**:
- max_rows=10000 可能在高峰时段频繁刷盘
- max_bytes=1MB 对于高吞吐场景偏小

**建议优化**:
```sql
-- 更激进的缓冲配置（如果内存允许）
ENGINE = Buffer(..., 30, 120, 1000, 50000, 100000, 5000000)
-- 时间: 30-120秒
-- 行数: 1000-50000
-- 字节: 100KB-5MB
```

---

#### 风险3: RealtimeStore 缺乏持久化保护

**问题描述**:
RealtimeStore 数据仅存内存，如果进程崩溃，最近几分钟的数据会丢失。

**代码位置**: `gateway.collector.ts:174-249`

**当前机制**:
```typescript
// flushBatch 中的处理
if (trafficDetailOk && trafficAggOk) {
  realtimeStore.clearTraffic(id);  // 成功后清理
}
```

**建议优化**:
1. **可选的持久化**: 考虑将 RealtimeStore 定期 checkpoint 到 SQLite（轻量级表）
2. **优雅关闭**: 确保 SIGTERM 时先 flush 再退出

---

#### 风险4: 查询时的热点数据竞争

**问题描述**:
`StatsDatabase` 使用了一些缓存的 prepared statements (`_summaryStmts`)，但在高并发查询时可能仍有锁竞争。

**代码位置**: `db.ts:81-83`

**建议优化**:
1. **连接池**: 考虑使用 `better-sqlite3` 的连接池模式
2. **只读副本**: 对于纯查询场景，可以考虑 SQLite 只读副本

---

#### 风险5: ClickHouse 连接未复用

**当前实现**:
```typescript
// clickhouse-writer.ts:232-243
const response = await fetch(url, {
  method: 'POST',
  // ... 每次新建连接
});
```

**问题**: 每次写入都新建 HTTP 连接，TCP 握手开销

**建议优化**:
1. **HTTP Keep-Alive**: 使用 `fetch` 的 keepalive 选项
2. **连接池**: 考虑使用 `undici` 或 `http.Agent` 保持连接

---

### 3.3 🔧 具体代码级优化建议

#### 建议1: 添加写入降级开关

```typescript
// stats-write-mode.ts
export function getSQLiteWriteMode(): 'full' | 'minimal' | 'none' {
  if (!isClickHouseOnlyModeEnabled()) return 'full';
  if (process.env.CH_SQLITE_WRITE_MODE === 'minimal') return 'minimal';
  if (process.env.CH_SQLITE_WRITE_MODE === 'none') return 'none';
  return 'minimal'; // 默认
}
```

#### 建议2: ClickHouse 写入添加压缩

```typescript
// clickhouse-writer.ts
const body = rows.map((row) => JSON.stringify(row)).join('\n');
const compressed = await gzip(body); // 添加压缩

await fetch(url, {
  headers: {
    'Content-Encoding': 'gzip', // 启用压缩
  },
  body: compressed,
});
```

#### 建议3: RealtimeStore 添加大小限制检查

```typescript
// realtime.store.ts
recordTraffic(...) {
  // 添加大小检查
  if (this.domainByBackend.size > RealtimeStore.MAX_DOMAIN_ENTRIES) {
    this.evictLeastUsedDomains(); // 淘汰最少使用
  }
}
```

---

## 四、数据一致性保障机制

### 4.1 双写一致性

```typescript
// batch-buffer.ts:137-152
if (!skipSqliteStatsWrites) {
  db.batchUpdateTrafficStats(backendId, updates, reduceSQLiteWrites);
}
if (clickHouseWriter.isEnabled()) {
  pendingTrafficWrite = clickHouseWriter.writeTrafficBatch(backendId, updates);
}
```

- SQLite 写入是同步的
- ClickHouse 写入是异步的，返回 Promise
- 失败时保留 RealtimeStore 数据，下次重试

### 4.2 查询一致性

```typescript
// stats.service.ts:321-346
const allCHReady = !!summaryCH && !!topDomainsCH && ...;
if (!allCHReady) {
  // 原子回退：任一失败则全部使用 SQLite
  return this.getSummary(backendId, timeRange);
}
```

### 4.3 数据校验服务

```typescript
// clickhouse.compare.ts
// 定期对比 SQLite 和 ClickHouse 的数据差异
// 输出: upload_delta, download_delta
```

---

## 五、配置调优建议

### 5.1 生产环境推荐配置

```bash
# SQLite 优化
SQLITE_CACHE_MB=128                    # 增大缓存
SQLITE_WAL_AUTOCHECKPOINT_PAGES=2000   # 减少checkpoint频率
SQLITE_BUSY_TIMEOUT_MS=10000           # 增加超时

# ClickHouse 写入优化
CH_WRITE_MAX_PENDING_BATCHES=300       # 适当增加队列
CH_WRITE_MAX_PENDING_ROWS=300000       # 增加行数限制

# 查询路由
STATS_QUERY_SOURCE=auto                # 自动路由
CH_STRICT_STATS=0                      # 允许降级

# RealtimeStore
REALTIME_MAX_MINUTES=240               # 增加保留时间
```

### 5.2 极端 IO 敏感场景

```bash
# 完全关闭 SQLite 统计写入（仅保留控制平面数据）
CH_ONLY_MODE=1
CH_WRITE_ENABLED=1
STATS_QUERY_SOURCE=clickhouse
CH_STRICT_STATS=1                      # 强制使用CH，不允许降级
```

---

## 六、总结

### 架构优势

1. **渐进式迁移**: 双写架构允许平滑过渡，随时可回退
2. **读写分离**: ClickHouse 承载分析查询，SQLite 处理事务性操作
3. **多层缓冲**: BatchBuffer → RealtimeStore → Buffer Table，层层削峰
4. **降级能力**: 任何组件故障都有兜底方案

### 主要风险

| 风险 | 等级 | 建议措施 |
|------|------|----------|
| SQLite 双写写放大 | 中 | 提供 `CH_ONLY_MODE` 完全关闭统计写入 |
| ClickHouse 连接开销 | 低 | 启用 HTTP Keep-Alive |
| RealtimeStore 数据丢失 | 低 | 添加优雅关闭和可选 checkpoint |
| Buffer 表配置保守 | 低 | 根据内存情况增大缓冲参数 |

### 下一步行动建议

1. **短期**: 监控 WAL 文件增长情况，评估 `CH_ONLY_MODE` 开启条件
2. **中期**: 实施连接复用，优化 ClickHouse 写入性能
3. **长期**: 考虑 RealtimeStore 持久化方案，确保数据零丢失
