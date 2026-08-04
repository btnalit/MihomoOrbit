# Neko Master 代码库综合研究报告（中文）

## 执行摘要

**Neko Master** 是一个面向边缘网关的现代网络流量分析平台，提供实时监控、流量审计与多网关管理能力。系统从 Clash/Mihomo 与 Surge 采集流量，聚合到 SQLite，并通过 Next.js 前端可视化。

---

## 1. 项目总览

### 1.1 目标与边界

Neko Master 是“流量可观测层”，它不提供代理接入或路由能力，而是聚焦：

- 从网关采集并聚合流量统计
- 向客户端推送实时 WebSocket 更新
- 提供历史流量分析与可视化
- 同时管理多个后端网关

### 1.2 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Next.js 16、React 19、TypeScript、Tailwind CSS v4 |
| UI | shadcn/ui（new-york）、lucide-react |
| 图表 | Recharts、D3.js、react-simple-maps |
| 状态管理 | TanStack React Query、WebSocket hooks |
| 后端 | Fastify 5、ws、better-sqlite3 |
| GeoIP | maxmind（本地 MMDB）+ 在线回退 |
| i18n | next-intl（zh/en） |
| 工程化 | Turbo monorepo、pnpm workspaces |
| 部署 | Docker、Next.js standalone |

### 1.3 仓库结构

```text
neko-master/
├── apps/
│   ├── collector/                 # 后端采集服务
│   │   └── src/
│   │       ├── index.ts           # 入口，编排全部服务
│   │       ├── app.ts             # Fastify API
│   │       ├── websocket.ts       # WebSocket 广播
│   │       ├── collector.ts       # Clash WS 采集
│   │       ├── surge-collector.ts # Surge 轮询采集
│   │       ├── realtime.ts        # 内存实时聚合
│   │       ├── batch-buffer.ts    # 批量写入优化
│   │       ├── geo-service.ts     # GeoIP 服务
│   │       ├── db.ts              # 数据库门面
│   │       └── database/          # schema + repositories
│   └── web/                       # Next.js 前端
├── packages/
│   └── shared/                    # 共享类型与工具
└── docs/
```

---

## 2. 核心架构

### 2.1 高层数据流

```text
Clash/Mihomo --WebSocket--> Collector
Surge        --HTTP Poll--> Collector

Collector -> SQLite (持久化)
Collector -> RealtimeStore (低延迟)
Collector -> WS Server (实时推送)

Web UI 通过 HTTP + WebSocket 消费数据
```

### 2.2 三层模型

1. 前端层（Next.js）：HTTP 拉取 + WS 实时更新。
2. 采集层（Fastify + ws）：API、广播、网关采集。
3. 存储层（SQLite + 内存）：持久化 + 低延迟查询。

---

## 3. 后端深度分析

### 3.1 入口编排（`index.ts`）

启动流程包含：

1. 初始化数据库
2. 初始化 GeoIP
3. 启动 WS 服务（3002）
4. 启动 API（3001）
5. 每 5 秒执行后端管理循环
6. 每 6 小时执行自动清理

### 3.2 Clash 采集器（`collector.ts`）

- 连接 `ws://.../connections`
- 支持 Bearer 认证
- 断线后 5 秒重连
- 对每条连接计算流量增量并写入 batch + realtime
- 清理超时未出现连接（默认 5 分钟）

### 3.3 Surge 采集器（`surge-collector.ts`）

- 轮询 `GET /v1/requests/recent`
- 默认 2 秒，错误时指数退避
- 解析 `notes` 中策略路径并转换为统一链路格式
- 用 `recentlyCompleted`（5 分钟 TTL）防止重复计数

### 3.4 RealtimeStore（`realtime.ts`）

维护多个按 `backendId` 分片的实时 map：summary、minute、domain、ip、proxy、device、rule、country。

核心能力：

- `recordTraffic()` 写入实时增量
- `merge*()` 与数据库结果合并
- `clearTraffic()` 在 flush 后清空对应增量
- 超限时按流量淘汰低价值条目（底部 25%）

### 3.5 BatchBuffer（`batch-buffer.ts`）

- 复合键聚合：`backendId + minute + domain + ip + chain + rule + sourceIP...`
- flush 条件：30 秒或 5000 条
- 分两阶段写入：流量统计 + 国家统计

### 3.6 WebSocket 服务（`websocket.ts`）

连接与订阅流程：

1. 客户端连接（可通过 query token/cookie）
2. 服务端鉴权
3. 客户端发送 `subscribe`（后端、时间范围、最小推送间隔等）
4. 服务端按订阅推送 `stats`

机制细节：

- 全局广播节流（最小 1 秒）
- 客户端级最小推送间隔
- 摘要缓存：实时范围短 TTL，历史范围长 TTL

### 3.7 数据库层

#### 核心表

| 表 | 作用 |
|---|---|
| `domain_stats` | 域名聚合 |
| `ip_stats` | IP 聚合 |
| `proxy_stats` | 代理链路聚合 |
| `rule_stats` | 规则聚合 |
| `country_stats` | 国家聚合 |
| `device_stats` | 设备（源 IP）聚合 |

#### 事实表（范围查询）

| 表 | 粒度 | 场景 |
|---|---|---|
| `minute_dim_stats` | 分钟 | 短时间范围（<6h） |
| `hourly_dim_stats` | 小时 | 长时间范围（>6h） |

#### 设计模式

- `StatsDatabase` 门面 + 多仓库分域实现
- `BaseRepository` 提供通用解析和聚合工具
- DB 范围查询缓存：实时约 8 秒、历史约 5 分钟

### 3.8 GeoIP 服务（`geo-service.ts`）

双提供者：

1. 在线 API（默认）
2. 本地 MMDB（可选）

查找流程：私网短路 -> DB 缓存 -> 失败冷却 -> 并发去重 -> 队列限流查询 -> 回写缓存。

容错策略：

- 失败 IP 30 分钟冷却
- 队列溢出丢弃新请求
- 周期清理失败记录

---

## 4. 前端深度分析

### 4.1 Next 配置（`next.config.ts`）

- `/api/*` rewrite 到 collector
- PWA 仅生产启用
- 注入版本号与 WS 端口等环境变量

### 4.2 Dashboard 结构

`DashboardPage` 由 `Sidebar`、`Header`、`Content` 组成，`Content` 按 tab 切换：Overview、Domains、IPs、Proxies、Rules、Devices、Regions。

### 4.3 数据获取模式

- HTTP：React Query 拉取历史和分页数据
- WS：自定义 hook 订阅实时数据并更新本地状态/缓存

### 4.4 国际化

- `next-intl`
- 语言：`zh`（默认）、`en`
- 文案：`apps/web/messages/{zh,en}.json`

---

## 5. 多后端架构

### 5.1 后端隔离

- 数据库：主键包含 `backend_id`
- RealtimeStore：按后端分片
- WebSocket：客户端订阅特定后端

### 5.2 后端管理循环

每 5 秒执行：读取配置 -> 判断是否变更 -> 重启/启停采集器 -> 清理已删除后端实例。

### 5.3 后端类型

| 类型 | 协议 | 数据源 |
|---|---|---|
| `clash` | WebSocket | `/connections` |
| `surge` | HTTP 轮询 | `/v1/requests/recent` |

---

## 6. 认证与安全

### 6.1 Cookie 鉴权

1. 用户在设置中配置 token
2. 服务端 hash 后存入 `auth_config`
3. 登录后签发 `HttpOnly` cookie `neko-session`
4. 后续请求自动携带 cookie

### 6.2 鉴权中间件

- 公共路由跳过
- 当开启鉴权时，验证 cookie 或 Bearer token
- 校验失败返回 401

### 6.3 紧急访问模式

- `FORCE_ACCESS_CONTROL_OFF=true` 可临时关闭鉴权
- 仅用于恢复场景，不建议生产启用

---

## 7. 性能优化

### 7.1 DB 级

- WAL 模式
- `synchronous=NORMAL`
- 增大 cache
- 内存临时表
- busy timeout

### 7.2 应用级

- 批量写入（30 秒或 5000 条）
- 查询缓存（实时短 TTL / 历史长 TTL）
- 内存 RealtimeStore 增量聚合
- WS 广播节流
- GeoIP 查询限速

### 7.3 内存治理

- domain/ip 上限 50K
- 超限淘汰低流量项
- 连接陈旧清理

---

## 8. 数据保留

配置存储于 `app_config`：

- `retention.connection_logs_days`
- `retention.hourly_stats_days`
- `retention.auto_cleanup`

自动清理每 6 小时执行一次，按阈值删除过期 minute/hourly 数据。

---

## 9. 环境变量

### 9.1 核心变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DB_PATH` | `./stats.db` | SQLite 路径 |
| `COOKIE_SECRET` | 自动生成 | Cookie 签名密钥 |
| `API_PORT` | 3001 | API 端口 |
| `COLLECTOR_WS_PORT` | 3002 | WS 端口 |
| `WEB_PORT` | 3000 | Web 端口 |

### 9.2 调优变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `FLUSH_INTERVAL_MS` | 30000 | flush 间隔 |
| `FLUSH_MAX_BUFFER_SIZE` | 5000 | 缓冲上限 |
| `REALTIME_MAX_MINUTES` | 180 | 实时窗口 |
| `DB_RANGE_QUERY_CACHE_TTL_MS` | 8000 | 实时查询缓存 TTL |
| `DB_HISTORICAL_QUERY_CACHE_TTL_MS` | 300000 | 历史查询缓存 TTL |

---

## 10. 测试

- 框架：Vitest
- 位置：`apps/collector/src/**/*.test.ts`
- 以仓库与服务层测试为主，前端自动化测试仍偏少

常用命令：

```bash
pnpm --filter @neko-master/collector test
pnpm --filter @neko-master/collector test -- src/modules/auth/auth.service.test.ts
pnpm --filter @neko-master/collector test:watch
```

---

## 11. Docker 部署

- 单容器运行：Web（3000）+ API（3001）+ WS（3002）
- 推荐使用 `docker-compose` 挂载 `data` 与可选 `geoip` 目录
- 反向代理需正确转发 `/_cm_ws` 并设置 Upgrade 头

---

## 12. 关键设计模式

1. Repository Pattern：分离数据访问与业务逻辑
2. Facade Pattern：`StatsDatabase` 统一入口
3. Observer Pattern：WS 广播订阅更新
4. Strategy Pattern：GeoIP 在线/本地策略切换
5. Batch Aggregation Pattern：批量聚合写入，显著降低 I/O

---

## 13. 可改进方向

1. 类型安全：GeoIP 返回类型可再收紧
2. 错误体系：可引入更统一的结构化错误模型
3. 性能：RealtimeStore 可探索 LRU 替代当前淘汰策略
4. 测试：补齐前端与端到端覆盖
5. 文档：可生成 OpenAPI/Swagger 文档

---

## 14. 结论

Neko Master 在架构上实现了采集、存储、展示的清晰分层，并通过批量聚合、实时缓存和多后端隔离获得了较好的性能与可维护性。整体已具备生产可用形态，后续可在测试深度、契约治理和观测性上进一步加强。
