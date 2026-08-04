<p align="center">
  <img src="./assets/icon-mihomo-orbit.png" width="160" alt="MihomoOrbit">
  <br>
  <b style="font-size: 32px;">MihomoOrbit</b>
</p>

<p align="center">
  <b>看清、并接管你的网络流量。</b><br>
  <span>流量监控 · 实时管理 · 配置编辑</span>
</p>

---

MihomoOrbit 是面向 Mihomo / Clash.Meta 生态的一体化面板:在原有的流量分析之上,逐步补齐**实时管理**(代理组切换、测速、连接管理、日志)与**配置编辑**(元数据驱动的 `config.yaml` 编辑、版本与回滚)。

部署形态是一个 collector 加任意多个后端。collector 直连各实例的 Mihomo external controller 做监控与运行时管理;需要改配置文件的后端再额外绑定一个常驻 Go 探针(agent),由它负责读取与原子写回。

## 当前状态

**v0.1.0 — M0 基线。** 这是从 [neko-master](https://github.com/foru17/neko-master) v1.4.5 硬分叉而来的第一个可构建版本:完成全量改名、强制认证与凭据硬化、后端能力契约。实时管理与配置编辑尚未实现。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 仓库引导:改名、强制认证、`backendCapabilities` 契约 | ✅ |
| M1 | 实时管理:代理组 / 连接表 / 日志 / 运行时设置 | 规划中 |
| M1c | 统一后端模型:schema 迁移与凭据拆分 | 规划中 |
| M2 | 配置编辑:agent 读取上报 + 心跳捎带指令写回 | 规划中 |
| M3 | 开源整理:双语文档、多平台镜像、发布流水线 | 规划中 |

## 快速开始

```bash
docker compose up -d
```

首次启动时**认证尚未配置**,collector 会在启动日志里打印一次性 setup token 与引导地址:

```
[SETUP] Authentication is not configured yet.
  Open  http://<host>:3000/  and use this one-time setup token:
      <64 位十六进制>
```

用该 token 在网页上设置一个**至少 16 位**的访问令牌即可完成初始化。setup token 每次重启轮换,设置完成后立即失效。

> 认证是**强制**的,没有关闭开关。`FORCE_ACCESS_CONTROL_OFF=true` 仅作为找回令牌的救援通道,启动时会打印安全告警,用完请立即移除。

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
