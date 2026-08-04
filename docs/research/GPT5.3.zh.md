# Neko Master 单体仓库深度研究（GPT-5.3）

本文是对 `/Users/luolei/DEV/clash-master` 的中文研究整理，覆盖架构、运行机制、代码分层、边界场景和运维细节。

## 1）仓库定位

Neko Master 是一个基于 `pnpm` 的网络流量分析与可视化单体仓库：

- `apps/collector`：后端采集 + API + WebSocket 推送（Fastify + ws + SQLite）
- `apps/web`：Next.js 仪表盘前端（App Router、next-intl、React Query）
- `packages/shared`：前后端共享契约与工具

核心能力：采集 Clash/Mihomo 与 Surge 流量，聚合为多维统计，并提供近实时展示。

## 2）Monorepo 构建与任务编排

### 工作区与任务运行器

- 工作区配置：`pnpm-workspace.yaml`、根目录 `package.json`
- 任务编排：`turbo.json`
- 根命令：
  - `pnpm dev` -> `turbo dev`
  - `pnpm build` -> `turbo build`
  - `pnpm lint` -> `turbo lint`

### Turbo 行为要点

- `build` 按依赖图执行（`^build`），缓存 `dist/**` 与 `.next/**`（排除 `.next/cache/**`）
- `dev` 为长驻任务，不走缓存
- `lint` 同样尊重依赖图（`^lint`）
- 全局缓存失效包含 `**/.env.*local`

## 3）Collector 深入分析（`apps/collector`）

### 3.1 运行拓扑与启动顺序

入口：`apps/collector/src/index.ts`

单进程内承载：

- Fastify API 服务（`APIServer`）
- 独立 WebSocket 服务（`StatsWebSocketServer`）
- 每个后端一个采集器实例（Clash WS 或 Surge 轮询）
- GeoIP 服务（`GeoIPService`）
- Surge 策略同步服务（`SurgePolicySyncService`）

`main()` 启动流程：

1. 加载 `.env.local`（若存在）后再加载 `.env`
2. 初始化 SQLite 门面（`StatsDatabase`）
3. 初始化 GeoIP 服务
4. 启动 WebSocket 服务（默认 `3002`）
5. 启动策略同步服务
6. 启动 Fastify API 服务（默认 `3001`）
7. 立即执行后端管理循环，并每 5 秒轮询一次
8. 安排保留期清理任务（+30 秒首次，之后每 6 小时）
9. 注册优雅退出（`SIGINT`/`SIGTERM`）

### 3.2 多后端生命周期管理

`manageBackends()` 持续将数据库配置与内存采集器状态对齐：

- 对启用且 listening 的后端启动采集器
- 当 `url`、`token`、`type`、`listening`、`enabled` 变化时重启采集器
- 对删除/禁用/非 listening 的后端停止采集器

状态以 `backendId` 为键，保证后端隔离。

### 3.3 Clash 采集链路（WebSocket）

实现：`apps/collector/src/collector.ts`

- 连接上游 `/connections` WebSocket
- 使用 `Map<id, TrackedConnection>` 维护连接快照
- 每次更新计算正向增量（`max(0, current - previous)`）
- 安全忽略无效或空帧
- 清理缺失连接 ID，并周期性移除陈旧连接
- 断连重试为固定间隔（非指数退避）

### 3.4 Surge 采集链路（HTTP 轮询）

实现：`apps/collector/src/surge-collector.ts`

- 轮询 `/v1/requests/recent`（默认约 2 秒）
- 请求失败采用指数退避
- 4xx 在重试路径中视为不可重试
- 以请求 ID 跟踪并计算增量字节
- 处理计数器重置场景（`current < previous`）
- 使用 `recentlyCompleted`（约 5 分钟 TTL）避免已完成请求重复计数
- 从 Surge notes 解析策略/规则链

### 3.5 批量写入、聚合与实时态协同

批缓冲层：`apps/collector/src/batch-buffer.ts`

- 触发 flush 条件：
  - 定时（`FLUSH_INTERVAL_MS`，默认 `30000`）
  - 缓冲阈值（`FLUSH_MAX_BUFFER_SIZE`，默认 `5000`）
- Flush 批量写入流量与国家统计

写入仓库：`apps/collector/src/database/repositories/traffic-writer.repository.ts`

- SQL 写入前先在内存预聚合
- 多聚合表按事务组写入

与实时数据协同：

- 增量同步写入 `realtimeStore`
- DB flush 成功后清理对应实时增量，避免双计
- 采集器触发 WS 广播并带内部节流

### 3.6 API 架构与模块边界

组装入口：`apps/collector/src/app.ts`

- 注册 CORS、cookie 插件、服务注入与模块控制器
- 控制器前缀：
  - `/api/backends`
  - `/api/stats`
  - `/api/auth`
  - `/api/db`
- 兼容路由直接在 `app.ts` 挂载：
  - `/api/gateway/proxies`
  - `/api/gateway/providers/proxies`
  - `/api/gateway/providers/proxies/refresh`
  - `/api/gateway/rules`
  - `/health`

模式：控制器薄编排，服务承载业务，`StatsDatabase` + repository 承载数据访问与转换。

### 3.7 认证与访问控制细节

认证服务：`apps/collector/src/modules/auth/auth.service.ts`

- token 以 SHA-256 哈希存储
- 运行期支持：
  - cookie（`neko-session`）
  - Bearer 令牌回退（`Authorization: Bearer ...`）
- 公共路由跳过鉴权（如 `/health`、`/api/auth/state`、`/api/auth/verify`、`/api/auth/logout`）

特殊模式：

- `FORCE_ACCESS_CONTROL_OFF=true`：关闭鉴权
- `SHOWCASE_SITE_MODE=true`：屏蔽多数写操作并隐藏后端敏感 URL

Cookie Secret 行为：

- 未配置 `COOKIE_SECRET` 时服务端自动生成
- 生产环境若不持久化会导致重启后会话失效

### 3.8 WebSocket 协议与行为

服务：`apps/collector/src/websocket.ts`

- 独立 WS 服务运行于 collector 进程
- 认证支持 cookie 或 query token
- 入站消息类型包含 `ping`、`subscribe`
- 订阅 payload 支持后端、时间范围、细节开关、分页/趋势选项、最小推送间隔
- 连接/订阅后会推送初始数据
- 全局广播节流 + 客户端最小推送间隔双重控制
- 服务器按查询形状缓存结果，避免每客户端重复计算
- 摘要缓存 TTL 随“是否接近当前时刻”动态变化

实时合并策略：仅当查询结束时间接近“当前”时，才合并内存增量（`REALTIME_RANGE_END_TOLERANCE_MS`）。

### 3.9 数据库设计与查询策略

相关文件：`apps/collector/src/database/schema.ts`、`apps/collector/src/db.ts`

设计特征：

- SQLite + WAL + 性能 pragma
- 关键表均按 `backend_id` 作用域隔离
- 累计聚合表与分钟/小时事实表组合

优化要点：

- 范围查询按时间跨度自动选择分钟或小时事实表（常见阈值 6 小时）
- DB 范围查询缓存按时间新鲜度分配短/长 TTL

保留策略：

- 保留配置在 `app_config` / retention API
- 自动清理定期裁剪过旧分钟/小时统计及关联事实数据

### 3.10 GeoIP 子系统

服务：`apps/collector/src/geo-service.ts`

关键行为：

- 私网 IP 快速归类
- 优先查询数据库缓存（`geoip_cache`）
- 并发去重（`pendingQueries`）
- 失败 IP 冷却，防止反复打满上游
- 队列 + 节流控制在线查询

提供者模式：

- 支持 online/local 两种
- local 依赖 MaxMind MMDB（City + ASN）
- local 不可用时回退 online
- 配置接口可返回“配置值”与“生效值”，并校验本地依赖完整性

### 3.11 测试覆盖现状

测试体系：Vitest（`apps/collector/vitest.config.ts`）

- 测试辅助：`apps/collector/src/__tests__/helpers.ts`
- 每轮测试使用临时 SQLite 数据库

已覆盖：

- auth service
- stats service
- traffic writer repository
- geoip 配置与归一化逻辑

薄弱区：

- `index.ts` 启动编排
- Clash/Surge 采集运行时边界行为
- WS 协议集成与鉴权边界
- 后端生命周期循环的竞态场景

### 3.12 风险与注意点

- 控制器中仍有部分手工参数校验，集中式 schema 校验不足
- 定时触发的 `manageBackends` 缺少显式 single-flight，存在并发重叠可能
- 部分模块内存在历史并行路径，可能增加理解成本
- 部分字段以逗号拼接存储，规模扩大后可能影响查询精度与维护性

## 4）Web 前端深入分析（`apps/web`）

### 4.1 路由与多语言

关键文件：

- `apps/web/app/[locale]/layout.tsx`
- `apps/web/app/[locale]/page.tsx`
- `apps/web/app/[locale]/dashboard/page.tsx`
- `apps/web/proxy.ts`
- `apps/web/i18n/routing.ts`
- `apps/web/i18n/request.ts`

行为：

- App Router 多语言路由（`en`、`zh`，默认 `zh`）
- locale 根页直接复用 dashboard
- `proxy.ts` 中 next-intl 中间件处理语言路由与 matcher 排除

### 4.2 数据层与 API 客户端

核心客户端：`apps/web/lib/api.ts`

- 提供类型化 API 门面
- API base 解析优先级：
  1. `window.__RUNTIME_CONFIG__.API_URL`
  2. 环境变量（`NEXT_PUBLIC_API_URL` / `API_URL`）
  3. `/api`
- GET 并发去重，避免重复请求
- 401 触发 `api:unauthorized` 事件，同步全局鉴权状态
- 错误模型使用 `ApiError`（`apps/web/lib/api-error.ts`）

React Query 默认：`staleTime ~5s`、`gcTime ~5m`、`retry 1`，在 `hooks/api/*` 与 `lib/query-config.ts` 可按场景覆写。

### 4.3 Dashboard 组合与状态

核心 hook：`apps/web/app/[locale]/dashboard/hooks/use-dashboard.ts`

- 协调 tab、时间范围、后端选择、翻译、鉴权感知与数据拉取策略
- 根据 tab 与刷新模式组合 HTTP + WS
- 页面由 `Sidebar`、`Header`、`Content` 组合；`Content` 按 tab 切换模块

### 4.4 前端 WebSocket 策略

实现：`apps/web/lib/websocket.ts`

- 端点候选支持运行时/env 配置和推断回退
- 生产环境倾向优先尝试路径式 `/_cm_ws`
- 心跳 ping/pong + 延迟跟踪
- 指数重连 + 端点轮换
- `subscribe` payload 支持精细化控制返回数据形状

多模块会将 WS 更新合并回 React Query 缓存，实现低延迟体验。

### 4.5 鉴权 UX 流程

核心：`apps/web/lib/auth.tsx`

- 全局 provider 决定是否开启鉴权与会话状态
- `AuthGuard` 在必要时展示登录对话框
- logout 清理会话并刷新
- 接收到 API 未授权事件后降级本地鉴权状态

### 4.6 UI 与主题系统

- Tailwind v4（`app/globals.css`、`postcss.config.mjs`）
- shadcn/ui（`apps/web/components.json`，`new-york` 风格）
- 基础组件在 `apps/web/components/ui/*`
- next-themes 管理主题与主题色同步
- framer-motion 在关键交互点按需使用

### 4.7 PWA / Service Worker

相关文件：

- `apps/web/app/manifest.ts`
- `apps/web/public/sw.js`
- `apps/web/components/common/sw-register.tsx`
- `apps/web/next.config.ts`

注意：自定义 SW 逻辑与生产环境 next-pwa 插件并存，不同环境行为需专项验证。

### 4.8 前端风险点

- 某些视图可能并发建立多个 WS 连接
- 与后端 WS payload（尤其 `stats` 可选字段）耦合较深
- 语言切换依赖路径字符串规则，未来路由形状变化需谨慎
- viewport 禁止用户缩放，存在可访问性权衡

## 5）共享包分析（`packages/shared`）

主文件：`packages/shared/src/index.ts`

提供：统计、网关 payload、WS 更新、鉴权、Surge 模型等共享契约，以及工具导出：

- `gateway-utils.ts`
- `geo-ip-utils.ts`

关键工具：

- `buildGatewayHeaders`：按网关类型构造请求头
- `parseSurgeRule` / `parseGatewayRule`：规则归一化解析
- `getGatewayBaseUrl`：归一化提取网关基础 URL
- `normalizeGeoIP`：兼容不同 Geo payload 形态

注意：`workspace:*` 依赖意味着 shared 改动会立即影响两端，必须按跨应用契约变更对待。

## 6）部署与运行时配置

### 6.1 Next 重写与运行时配置

- 浏览器 API 常走 `/api/*`
- Next rewrites 将 `/api/:path*` 转发到 `API_URL`
- `public/runtime-config.js` 支持部署时覆盖，无需重建镜像

### 6.2 Docker 与启动脚本

相关文件：`Dockerfile`、`docker-compose.yml`、`docker-start.sh`、`.dockerignore`

关键行为：

- 若缺失 `COOKIE_SECRET`，启动脚本会在挂载数据卷中自动生成并持久化
- 容器启动时动态注入 runtime config
- 镜像采用多阶段构建，CI 支持多架构

## 7）Git Hook 与 CI 质量门禁

`/.husky/pre-push`（仅 push 到 `main` 时生效）：

- collector: `tsc --noEmit`
- web: 生产构建

GitHub Actions 包含：

- Docker build/publish
- dev 与 main 同步检查
- dev preview 分支自动化

观察：当前 CI 对容器可构建性要求较强，但 lint/test 深度仍有提升空间。

## 8）文档与实现偏差

架构文档对概念层面有价值，但部分目录命名与 collector 当前实现存在时序差异；做实现级决策时以代码路径为准。

## 9）优势、风险与实操建议

### 优势

- monorepo 分层清晰，shared 契约明确
- 实时架构合理（DB 持久化 + 内存增量 + WS 推送）
- 前端部署支持 runtime config，运维灵活
- `backendId` 隔离贯穿数据链路

### 主要风险

- 采集编排与 WS 协议等关键路径测试覆盖偏薄
- 后端管理循环存在潜在并发重叠
- 历史/并行代码路径增加维护复杂度
- 前后端协议（尤其 WS）耦合较强

### 修改前建议

1. `packages/shared` 类型是跨应用契约，改动要联动验证。
2. collector 为 ESM，相对导入需 `.js` 后缀。
3. Web API 基址与 WS 端点支持运行时覆盖，排查问题先确认生效配置。
4. 新增读写链路必须保持 `backendId` 隔离。
5. 同时验证实时模式与 HTTP 回退模式。
6. 涉及鉴权时同时验证 cookie 与 bearer 路径。

## 10）后续可选研究方向

- 建立 HTTP + WS 端点矩阵（请求/响应 schema + 源函数映射）
- 增加采集可靠性专项评估（Clash 与 Surge 在重连/退避策略的一致性）
- 制定测试补齐计划，优先 `index.ts` 编排与 `websocket.ts` 协议行为
