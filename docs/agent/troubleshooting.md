# Agent 故障排查

**中文 | [English](./troubleshooting.en.md)**

## `exec format error`

原因：二进制架构与主机不匹配。

检查：

```sh
file ./neko-agent
uname -m
```

修复：使用与当前目标匹配的发布包。

## Agent 始终离线

检查清单：

- `--server-url` 指向面板主机地址（而非远程机器的 localhost）
- backend token 为最新（未轮换/过期）
- 后端已设置为 Agent 模式
- Agent 主机可访问面板的心跳端点

## `Invalid agent token`

- Agent 进程与后端配置的 token 不匹配
- 在 UI 中轮换 token，并使用新 token 重启 Agent

## `AGENT_TOKEN_ALREADY_BOUND`

原因：同一 backend token 被另一个 `agentId` 使用。

修复：

- 不要在多个 Agent 实例间共用同一 backend token
- 每个 Agent 对应独立后端，或故意轮换 token 后重新绑定

## `426` 兼容性错误

可能的错误码：

- `AGENT_PROTOCOL_TOO_OLD`
- `AGENT_VERSION_REQUIRED`
- `AGENT_VERSION_TOO_OLD`

修复：

- 升级 Agent 到更新的发布版本
- 检查 collector 环境变量要求：
  - `MIN_AGENT_PROTOCOL_VERSION`
  - `MIN_AGENT_VERSION`

## Agent 无法启动：PID 文件 / 已在运行

Agent 二进制使用 PID 锁文件防止同一 backendId 运行两个进程。
若上次崩溃遗留了过期 PID 文件，新进程会立即退出。

检查：

```bash
nekoagent status <instance>
```

若显示"已停止"但仍无法启动：

```bash
# 找到并删除过期 PID 文件
ls /var/run/neko-agent/
rm /var/run/neko-agent/<instance>.pid
nekoagent start <instance>
```

## `nekoagent stop` 耗时较长

这是预期行为。停止时，Agent 会等待最多 10 秒以将最后一批流量数据 flush 至面板后再退出。stop 命令最多等待 12 秒，之后才发送 SIGKILL。

如需立即强制终止：

```bash
pid=$(cat /var/run/neko-agent/<instance>.pid)
kill -9 "$pid"
rm -f /var/run/neko-agent/<instance>.pid
```

注意：强制终止可能丢失最后约 30 秒尚未 flush 的流量数据。

## `nekoagent logs` 无输出

日志文件在首次成功启动后才会创建。若 Agent 启动即失败，可通过以下方式排查：

```bash
journalctl -u neko-agent-<instance> -n 50    # 使用 systemd 时
# 或直接查看日志文件
cat /var/run/neko-agent/<instance>.log
```

## Agent 有上报但面板无数据

可能原因：

1. 网关类型不匹配——确认 `--gateway-type` 与实际网关一致（`clash` vs `surge`）
2. Agent 主机无法访问网关 URL——测试：`curl http://<gateway-url>/version`
3. 首次 flush 尚未发生——等待 30 秒（默认 flush 间隔）
4. 后端处于直连模式而非 Agent 模式——检查 UI 中的后端设置

## Surge 解析错误

最新 Agent 解析器支持混合字段格式（`id` 字段为数字或字符串、数字字符串）。
若仍然报错，请收集错误日志并附响应样本提交 Issue。
