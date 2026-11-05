# MCP 客户端配置示例

FoxPaw 是一个远程 MCP 服务器（Streamable HTTP）：

- 地址：`https://foxpaw.aiyuancat.com/mcp`
- 鉴权：请求头 `Authorization: Bearer <token>`；令牌错误或已吊销时回 HTTP 401
- 令牌怎么来：主人在控制台生成邀请，Agent 用邀请码领取（见 [claim-token.sh](claim-token.sh)）。领取回包里的 `config_snippet` 已经填好令牌，能直接用。

下面所有示例里的 `<token>` 都要换成你领到的令牌。**不要把真实令牌提交进任何仓库**；能用环境变量的客户端优先用环境变量。

| 客户端 | 文件 | 放在哪里 |
|---|---|---|
| Claude Code | [claude-code/add.sh](claude-code/add.sh)（一条命令）或 [claude-code/mcp.json](claude-code/mcp.json) | 命令行执行；或项目根目录 `.mcp.json`（示例用环境变量 `FOXPAW_TOKEN`） |
| Codex | [codex/config.toml](codex/config.toml) | `~/.codex/config.toml`（CLI、IDE 扩展、桌面应用共用） |
| Cursor | [cursor/mcp.json](cursor/mcp.json) | `~/.cursor/mcp.json`（全局）或项目内 `.cursor/mcp.json` |
| VS Code（Copilot Chat） | [vscode/mcp.json](vscode/mcp.json) | 项目内 `.vscode/mcp.json` |
| 其他认 `mcpServers` 的客户端 | [generic/mcp-servers.json](generic/mcp-servers.json) | 以客户端文档为准；类型字段有的写 `streamableHttp`，有的写 `http`（[http 版](generic/mcp-servers.http-type.json)），也有写 `streamable-http` 的 |
| 只支持本地 stdio 的客户端 | [stdio-bridge/mcp-servers.json](stdio-bridge/mcp-servers.json) | 通过社区工具 `mcp-remote`（npm）把远程 HTTP 转成 stdio；需要本机有 Node.js |

各客户端的配置格式会随版本变化，**以客户端自己的文档为准**；FoxPaw 这边只需要「地址 + Bearer 令牌」两样。

接入后第一步：调用 `foxpaw_whoami`，看自己的权限、可用设备和授权标签。完整工具说明见 [../docs/agent-guide.md](../docs/agent-guide.md)。

令牌泄露时，请主人在控制台「Agent」里吊销后重新邀请；吊销立即生效。
