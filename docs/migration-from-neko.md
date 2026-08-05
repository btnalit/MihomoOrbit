# 从 neko-master 迁移到 MihomoOrbit

MihomoOrbit 硬分叉自 neko-master v1.4.5,标识符一次性全量改名,**不做新旧双前缀兼容读取**。唯一刻意保留的兼容点是 agent 的旧锁文件路径,原因见下。

## ⚠️ 必做前置:先卸载旧的 nekoagent

**这一步不是建议,是强制的。**

新旧两个 agent 的默认 agentId 都由 `sha256(backendToken)[:16]` 派生,**与二进制名无关**。也就是说同一后端令牌下,残留的 `neko-agent` 与新的 `orbit-agent` 会算出完全相同的 agentId,collector 无法区分二者,会同时接受两者的上报——**同一份流量被统计两遍**。

为此新 agent 启动时会**同时占用新旧两个锁文件**(`orbit-agent-backend-<id>.lock` 与 `neko-agent-backend-<id>.lock`),任一被占用即拒绝启动;`install.sh` 也会主动探测旧安装并拒绝继续。

> ⚠️ **锁是纵深防御,不是充分条件**:它能挡住"旧 agent 先启动"的情形,但反过来不行——如果旧的 `neko-agent` 服务被重新启用并在 orbit-agent **之后**启动,旧二进制自带的存活检测只认 `neko-agent` 这个进程名,会把 orbit-agent 持有的旧锁文件误判为陈旧、直接删除并抢占,而 orbit-agent 并不会立刻发现。为此 orbit-agent 会每隔约 60 秒自检一次锁的归属,一旦发现锁被存活的其他 agent 进程抢走且无法夺回,会记录明确日志并主动退出,避免继续和抢锁方同时上报造成双写。但这只是兜底,**真正的解法仍是彻底卸载/禁用旧的 `neko-agent` 服务**——`install.sh` 已经会做这个检测。

```sh
# 旧 agent 所在主机上执行
nekoagent list
nekoagent remove <instance>
# 或(OpenWrt / 手工安装)
/etc/init.d/neko-agent stop && rm -rf /etc/neko-agent /var/run/neko-agent
```

确认无残留后再安装新 agent。确需并存(仅用于排障)可设 `ORBIT_FORCE_INSTALL=1` 跳过检测,但双写统计后果自负。

## 认证:旧令牌一律失效

M0 起认证是**强制**的,并做了凭据硬化:

- 令牌最短 **16 位**(原为 6 位)。
- 哈希从无盐单轮 SHA-256 换为 **scrypt 加盐**。
- 旧的 sha256 令牌**不做透明升级**,而是被视为"未配置"——否则从旧库带过来的 6 位令牌会永久合法,新的长度下限对最该受保护的人从不生效。

因此**复用旧 `stats.db` 时,原有令牌一律失效**,首次启动会进入设置流:从 collector 启动日志中取一次性 setup token,重新设置一个至少 16 位的令牌。

`FORCE_ACCESS_CONTROL_OFF=true` 保留为救援通道,启动时打印安全告警,用完请立即移除。

> ⚠️ **例外**:救援通道会绕过整个设置流程。若在 legacy 哈希的库上开着它,旧的弱令牌既不会被强制重设、也照常可用——"旧令牌一律失效"仅在救援通道关闭时成立。collector 检测到 legacy 哈希时会在启动日志中单独告警。

## 复用 ClickHouse 现有数据

默认库/用户/密码已改名。要继续使用旧数据,把环境变量指回旧值:

```sh
CH_DATABASE=neko_master
CH_USER=neko
CH_PASSWORD=neko_master
```

SQLite 路径 `/app/data/stats.db` 与所有数据库表名**保持不变**,无需迁移。

## 完整命名映射

| 类别 | 旧 | 新 |
|---|---|---|
| npm scope | `@neko-master/*` | `@mihomo-orbit/*` |
| 根包名 | `neko-master` | `mihomo-orbit` |
| Go module | `github.com/foru17/neko-master/apps/agent` | `github.com/btnalit/MihomoOrbit/apps/agent` |
| agent 二进制 | `neko-agent` | `orbit-agent` |
| agent 管理命令 | `nekoagent` | `orbitagent` |
| agent 环境变量 | `NEKO_*` | `ORBIT_*` |
| agent 配置目录 | `/etc/neko-agent` | `/etc/orbit-agent` |
| agent 状态目录 | `/var/run/neko-agent` | `/var/run/orbit-agent` |
| systemd/procd 服务 | `neko-agent-<name>` | `orbit-agent-<name>` |
| launchd label | `io.neko-master.agent.*` | `io.mihomo-orbit.agent.*` |
| agent 锁文件 | `neko-agent-backend-<id>.lock` | `orbit-agent-backend-<id>.lock`(**旧路径仍会被占用**,见上) |
| 发布资产 | `neko-agent_<os>_<arch>.tar.gz` | `orbit-agent_<os>_<arch>.tar.gz` |
| 会话 cookie | `neko-session` | `orbit-session` |
| localStorage | `neko-master-settings` | `mihomo-orbit-settings` |
| localStorage | `neko-agent-bootstrap-config-v1` | `orbit-agent-bootstrap-config-v1` |
| PWA 缓存键 | `neko-master-v1` | `mihomo-orbit-v1` |
| Docker 镜像 | `foru17/neko-master` | `ghcr.io/btnalit/mihomo-orbit` |
| compose 服务/容器/网络 | `neko-master*` | `mihomo-orbit*` |
| ClickHouse 默认库/用户/密码 | `neko_master` / `neko` / `neko_master` | `mihomo_orbit` / `orbit` / `mihomo_orbit` |
| GitHub 仓库 | `foru17/neko-master` | `btnalit/MihomoOrbit` |

**保持不变**:SQLite 路径 `/app/data/stats.db`、所有数据库表名、`AgentProtocolVersion` 数值。

## 已移除

- Docker Hub 推送(仅保留 GHCR)。
- 上游的 `dev` / `preview/**` 分支管理工作流。
- `README.en.md` / `README.zh.md` / `README_EN.md` / `CHANGELOG.en.md`(M3 重建双语文档)。
