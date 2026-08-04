# Agent 发布与打包

**中文 | [English](./release.en.md)**

## 标签策略

- Agent 发布工作流由 `agent-v*` 格式的标签触发
- 示例：`agent-v0.2.0`

## 生成的产物

每个目标 OS/架构均发布两个压缩包：

- 带版本号：`neko-agent_<tag>_<os>_<arch>.tar.gz`
- latest 别名：`neko-agent_<os>_<arch>.tar.gz`

同时发布：

- `checksums.txt`（所有压缩包的 SHA256）

## CI 工作流

- `.github/workflows/agent-build.yml`
  - 在 PR/push 时触发
  - 执行 `go test ./...`
  - 交叉编译矩阵验证

- `.github/workflows/agent-release.yml`
  - 在推送 `agent-v*` 标签时触发
  - 交叉编译、打包、生成校验和
  - 将发布产物发布到 GitHub Releases

## 兼容性门控（推荐）

Collector 在心跳/上报时验证 Agent 兼容性：

- `MIN_AGENT_PROTOCOL_VERSION`（默认 `1`）
- `MIN_AGENT_VERSION`（可选，如 `1.3.8`）

不兼容时，API 返回 `426` 并附带机器可读代码：

- `AGENT_PROTOCOL_TOO_OLD`
- `AGENT_VERSION_REQUIRED`
- `AGENT_VERSION_TOO_OLD`

## 兼容性矩阵模板

| Agent 版本 | 最低服务端版本 | 协议版本 |
| --- | --- | --- |
| `agent-v1.3.1` | `v1.3.1` | `1` |
| `agent-v1.3.8` | `v1.3.1` | `1` |

版本号不连续时，表示该版本无需独立 Agent 发布。

## 命名规范

- 压缩包内二进制文件始终命名为 `neko-agent`
- 压缩包名称包含平台信息，便于用户下载和脚本识别
- Linux 变体明确区分 `amd64/arm64/armv7/mips/mipsle`
