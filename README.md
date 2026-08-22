<p align="center">
  <img src="./assets/icon-mihomo-orbit.png" width="160" alt="MihomoOrbit">
  <br>
  <b style="font-size: 32px;">MihomoOrbit</b>
</p>

<p align="center">
  <b>看清、并接管你的网络流量。</b><br>
  <span>流量监控 · 实时管理 · 配置编辑</span>
</p>

<p align="center">
  <a href="https://github.com/btnalit/MihomoOrbit/releases"><img src="https://img.shields.io/github/v/release/btnalit/MihomoOrbit" alt="GitHub Release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://github.com/btnalit/MihomoOrbit/pkgs/container/mihomo-orbit"><img src="https://img.shields.io/badge/ghcr.io-mihomo--orbit-blue" alt="GHCR"></a>
</p>

---

MihomoOrbit 是面向 Mihomo / Clash.Meta 生态的一体化面板:在流量分析基础上提供**实时管理**(代理组切换、测速、连接管理、日志、运行时设置)与**配置编辑**(元数据驱动的 `config.yaml` 编辑、原子写回、版本历史与回滚)。

部署形态是一个 collector 加任意多个后端。collector 直连各实例的 Mihomo external controller 做监控与运行时管理;需要改配置文件的后端再额外绑定一个常驻 Go 探针(agent),由它负责读取与原子写回。

## 当前状态

**v0.3.0。** 统一后端模型(API 通道 + 可选 Agent 通道,能力按 `monitoring / management / configEdit` 门控)落地后,实时管理与配置编辑相继交付,随后完成三轮前端质量与交互审计整改。这是从 [neko-master](https://github.com/foru17/neko-master) v1.4.5 硬分叉后的第一个功能完整版本。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 仓库引导:改名、强制认证、`backendCapabilities` 契约 | ✅ |
| M1c | 统一后端模型:API 通道 + 可选 Agent 通道,凭据互斥防双写 | ✅ |
| M1 | 实时管理:代理组 / 连接表 / 日志 / 运行时设置,WS 中继 | ✅ |
| M1.5 | Providers 页(规则/代理提供者)、组页打磨 | ✅ |
| M2 | 配置编辑:元数据驱动表单 + agent v2 原子写回 + 版本回滚 | ✅ |
| M1.6–M1.8 | 前端质量整改三轮:分页、组面板动态编排、加密全集、交互审计修复 | ✅ |
| M3 | 开源整理:README 刷新、CI 自动发版(本轮) | ✅ |

## 功能

**流量分析**
- 实时流量可视化:概览、趋势图、Top 域名/代理/地区
- 规则链路图(RuleSet / 策略组匹配可视化)
- 两种采集模式:direct 直连 external controller、agent 被动上报
- SQLite + 可选 ClickHouse 双写,保留策略可配置

**实时管理**
- 代理组页:节点选择、组测速、延迟徽标
- 实时连接表:搜索、排序、kill
- 实时日志:级别筛选
- 运行时设置:模式 / 日志级别 / 局域网开关(仅作用于运行中内核)
- collector WebSocket 中继统一供数(引用计数、断路器、日志环形缓冲)

**配置编辑**
- 元数据驱动的 `config.yaml` 表单编辑(字段由 `config-metadata.json` 驱动,非硬编码)
- 六步原子写回:基线哈希冲突检测 → 三份轮转备份 → 原子替换 → reload → 三重健康门 → 失败自动回滚
- 版本历史与一键回滚
- 敏感字段掩码,注释与锚点保真(CST 级替换)

## 快速开始

```bash
docker compose up -d
```

默认拉取 `ghcr.io/btnalit/mihomo-orbit:latest`(多架构 amd64/arm64)。需要固定版本时,把 `docker-compose.yml` 里的 tag 换成对应的 semver 标签(如 `0.3.0`);每个 `v*` release 都会推送对应版本标签。

首次启动时**认证尚未配置**,collector 会在启动日志里打印一次性 setup token 与引导地址:

```
[SETUP] Authentication is not configured yet.
  Open  http://<host>:3000/  and use this one-time setup token:
      <64 位十六进制>
```

用该 token 在网页上设置一个**至少 16 位**的访问令牌即可完成初始化。setup token 每次重启轮换,设置完成后立即失效。

自动化部署可以用环境变量 `ORBIT_SETUP_TOKEN` 预置这个一次性 token,省去从日志里现读的步骤;值不足 16 位会被忽略并打印告警,退回生成随机 token(见 `.env.example`)。

> 认证是**强制**的,没有关闭开关。`FORCE_ACCESS_CONTROL_OFF=true` 仅作为找回令牌的救援通道,启动时会打印安全告警,用完请立即移除。

## 配置编辑与 Agent

配置编辑需要为对应后端绑定一个常驻 Go agent;纯监控/管理后端无需 agent。agent 二进制发布在 GitHub Releases 的 `agent-v*` 线(当前 `agent-v2.0.0`),安装、配置与协议兼容性说明见 [`docs/agent/`](./docs/agent/)。

写回全程原子:基线哈希冲突检测、写前备份、健康门校验失败即自动回滚,不落地半写配置。

## 版本与发布

- `v*` tag → 多架构(amd64/arm64)镜像推送 GHCR,并自动创建 GitHub Release(附 `docker-compose.yml` 与 `.env.example`);CI 校验 tag 与根 `package.json` 版本一致,不一致直接失败。
- `agent-v*` tag → 测试 + 多平台交叉编译 + 自动发布二进制 Release(附 `checksums.txt`)。
- 变更记录:[`CHANGELOG.md`](./CHANGELOG.md)(中文,主记录,含 neko-master 上游历史)、[`CHANGELOG.en.md`](./CHANGELOG.en.md)(英文)。

## 从 neko-master 迁移

见 [`docs/migration-from-neko.md`](./docs/migration-from-neko.md)。**务必先卸载旧的 `nekoagent`**——两个 agent 共用同一后端令牌时会把同一份流量统计两遍,新 agent 会因此拒绝启动。

## 开发

```bash
pnpm install          # pnpm 9.15.9 via corepack,Node 22
pnpm build
pnpm --filter @mihomo-orbit/collector test
pnpm check:api-routes

cd apps/agent && go test ./...      # 需类 Unix 环境;Windows 请用 GOOS=linux go vet ./...
```

仓库约定见 [`AGENTS.md`](./AGENTS.md)。

## Credits

MihomoOrbit 基于以下 MIT 许可项目构建:

- [neko-master](https://github.com/foru17/neko-master) by foru17 — 主体架构(硬分叉自 v1.4.5)
- [zashboard](https://github.com/Zephyruso/zashboard) — 实时管理交互参考
- [clash-config-editor](https://github.com/xiaoyutx94/clash-config-editor) — 配置编辑器与 `config-metadata.json`

## License

MIT。上游 neko-master 的版权声明保留在 [`LICENSE`](./LICENSE) 中。
