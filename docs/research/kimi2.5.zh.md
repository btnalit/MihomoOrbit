# Neko Master 深度研究报告（中文整理版）

## 执行摘要

**Neko Master**（ねこマスター）是一个网络流量分析与可视化平台，面向 Clash、Mihomo、Surge 等代理网关。项目采用 TypeScript monorepo，提供实时监控、历史分析和多后端管理能力。

---

## 项目概述

### 功能定位

Neko Master 主要能力：

- **收集**：从网关实时采集连接与流量数据
- **分析**：按域名、IP、代理链、规则、设备、地区聚合
- **可视化**：通过仪表盘和图表展示趋势与分布
- **管理**：统一管理多个后端网关
- **审计**：支持历史时序查询与回溯

### 典型场景

- 网络管理员做性能与异常观测
- 隐私关注用户审计流量去向
- 开发者调试网关策略/规则匹配
- 团队统一管理多实例网关

---

## 架构总览

### 仓库结构

```text
neko-master/
├── apps/
│   ├── web/                    # Next.js 16 前端
│   └── collector/              # Fastify 后端采集服务
├── packages/
│   └── shared/                 # 共享类型与工具
├── docs/
├── docker-compose.yml
└── Dockerfile
```

### 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | Next.js 16、React 19、TypeScript、Tailwind CSS v4、shadcn/ui、Recharts、TanStack Query、next-intl |
| 后端 | Node.js 22、Fastify 5、ws、SQLite（better-sqlite3）、MaxMind |
| 工具 | pnpm、Turborepo、Docker |

---

## 核心组件

### 1）前端（`apps/web`）

- App Router + `[locale]` 多语言路由（`zh`/`en`）
- 主页面包含 domains、ips、proxies、rules、devices、settings 等模块
- React Query 管理服务端状态，WebSocket 负责实时刷新
- 使用 shadcn/ui 与 Tailwind v4 构建响应式界面
- 具备 PWA 基础能力（manifest + service worker）

### 2）后端（`apps/collector`）

关键模块：

- `index.ts`：入口编排
- `app.ts`：Fastify API 注册
- `collector.ts`：Clash WS 采集
- `surge-collector.ts`：Surge HTTP 轮询
- `websocket.ts`：实时广播
- `realtime.ts`：内存实时聚合
- `db.ts` + `database/repositories/*`：数据库门面与仓库层

数据管道：

1. 网关数据进入采集器（WS 或 HTTP）
2. 计算增量并写入 RealtimeStore
3. 数据进入 BatchBuffer（30 秒/5000 条触发 flush）
4. 批量写入 SQLite 聚合表
5. WebSocket 向前端推送更新

### 3）共享包（`packages/shared`）

- 提供前后端共享的类型契约与工具函数
- 保持无副作用、低耦合
- 典型文件：`index.ts`、`gateway-utils.ts`、`geo-ip-utils.ts`

---

## 数据模型

### SQLite 设计

数据库启用 WAL 模式，核心表包括：

- `domain_stats`、`ip_stats`、`proxy_stats`、`rule_stats`、`country_stats`、`device_stats`
- 交叉表：`domain_proxy_stats`、`ip_proxy_stats`、`rule_domain_traffic`、`rule_ip_traffic`
- 时序表：`minute_*`、`hourly_*`、`daily_*`
- 配置表：`backend_configs`、`auth_config`、`geoip_cache`、`asn_cache`、`surge_policy_cache`

### RealtimeStore

按 `backendId` 分片维护域名、IP、代理、规则、设备等实时增量。查询时与 DB 数据合并，兼顾实时性与准确性。

---

## API 与通信

### REST API（摘要）

- 后端管理：`/api/backends/*`
- 统计查询：`/api/stats/*`、`/api/domains/*`、`/api/ips/*`、`/api/proxies/*`、`/api/rules/*`、`/api/devices/*`
- 网关代理：`/api/gateway/:backendId/*`
- 认证：`/api/auth/*`

### WebSocket

- 端点：`/_cm_ws`
- 认证：cookie（可配 token 方案）
- 订阅模型：客户端发送 `subscribe`，服务端推送 `stats` / `connections`
- 支持重连、心跳、按后端维度订阅

---

## 关键设计模式

1. **Repository Pattern**：仓库层封装查询和聚合逻辑。
2. **Dual Write Pattern**：实时写内存 + 批量落盘。
3. **Delta Merge Pattern**：查询时合并历史与实时增量。
4. **Fastify Plugin Pattern**：控制器模块化注册，服务通过装饰注入。

---

## 配置与运行

常用环境变量：

- `WEB_PORT`、`API_PORT`、`COLLECTOR_WS_PORT`
- `DB_PATH`、`COOKIE_SECRET`
- `GEOIP_LOOKUP_PROVIDER`、`MAXMIND_LICENSE_KEY`
- `FORCE_ACCESS_CONTROL_OFF`、`SHOWCASE_MODE`
- `FLUSH_INTERVAL_MS`、`FLUSH_MAX_BUFFER_SIZE`

后端配置包含：`id`、`name`、`type(clash/mihomo/surge)`、`url`、`secret`、`pollingInterval`、`enabled`。

---

## 开发流程

```bash
pnpm install
pnpm dev
pnpm build
pnpm lint
pnpm --filter @neko-master/collector test
```

单测可按文件或用例名过滤执行。

---

## 部署与安全

### Docker

- 多阶段构建，支持生产化镜像
- `docker-compose.yml` 暴露 3000（web）/3001（api）/3002（ws）
- 建议挂载 `data` 目录持久化数据库与关键配置

### 安全

- Cookie 会话 + token 登录
- bcrypt 密码哈希
- CORS、限流、参数校验
- SQL 参数化查询
- 可选只读展示模式

---

## 性能策略

- DB：WAL + 索引 + 批量写入
- 应用：RealtimeStore 热数据、WS 增量推送、写入去抖
- GeoIP：缓存 + 失败冷却 + 队列限速

---

## 风险与后续建议

### 当前风险

- 启动编排和 WS 协议路径的自动化覆盖仍可加强
- 定时后端管理循环存在潜在重叠执行风险
- 部分历史路径会提升理解与维护成本

### 建议方向

1. 补齐 collector 编排与 WS 协议集成测试。
2. 细化端点协议文档（HTTP/WS 请求响应 schema）。
3. 评估更细粒度的告警与异常检测能力。
4. 在多实例部署下增强横向扩展与缓存协同。

---

## 结论

Neko Master 在“实时性 + 持久化 + 多后端隔离”之间做了较好的工程平衡。它已经具备面向生产的核心能力，并在架构上保留了进一步演进到更高规模部署的空间。
