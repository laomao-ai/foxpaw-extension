# FoxPaw 从旧版迁移（中继 3.0 起）

中继 3.0 起，FoxPaw 把「登录、Agent 接口、页面」各收成一套。下面的旧接口已弃用：**暂时仍可用**，但每次调用都会带弃用提示；删除时间另行公告。新接入请直接用新方式。

## 一、登录只剩三种

| 谁 | 唯一方式 | 接口 |
|---|---|---|
| 主人 | 邮箱验证码 → 网页会话（Cookie，30 天） | `POST /auth/request-code` → `POST /auth/verify` |
| 浏览器（扩展） | 设备码流程 → 设备令牌 | `POST /auth/device/start` → 主人在 `/app/connect?code=<设备码>` 确认 → 扩展 `POST /auth/device/poll` 拿到连接串 |
| Agent | 邀请链接 → Agent 令牌 | 主人在控制台「接入 Agent」生成 `/app/claim?invite=<邀请码>` → `POST /auth/agent/claim {invite, label}` |

## 二、弃用对照

弃用的 HTTP 接口：回包 JSON 多一个 `deprecated` 字段（`api / since / removal / use / message / doc`），响应头带 `Deprecation: true`、`Link: <…/docs/migration-3.0>; rel="deprecation"`。

| 旧的 | 改用 | 说明 |
|---|---|---|
| `POST /auth/exchange`（账户连接码换连接串） | 设备码流程 | 扩展已去掉「用连接码连接」 |
| `POST /auth/my/reset-code`、`POST /app/api/reset-code` | 无需替代 | 连接码只为 exchange 存在 |
| `GET /app?ticket=…`（控制台免登票据） | 直接打开 `/app/…` | 会话 30 天；过期就在控制台用邮箱验证码登录 |
| 设备邀请 + `POST /claim/api` 领配对串 | 设备码流程 | |
| `POST /claim/api`（Agent 邀请） | `POST /auth/agent/claim` | 入参出参相同 |
| `GET /auth/my/devices`、`POST /auth/my/revoke` | 控制台「设备」「Agent」页 | |
| WS `/agent` 自定义 Agent 协议 | MCP `POST /mcp` | 命令对照见第三节 |
| 页面 `/connect`、`/claim`、`/account` | `/app/connect`、`/app/claim`、`/app/account` | 302 跳转并保留查询串 |

## 三、Agent：WS 命令 → MCP 工具

| WS kind | MCP 工具 |
|---|---|
| whoami | foxpaw_whoami |
| tabs / snapshot / navigate / click / fill / waitFor | foxpaw_tabs / foxpaw_snapshot / foxpaw_navigate / foxpaw_click / foxpaw_fill / foxpaw_wait_for |
| createTab / closeTab / activateTab / findTabs | foxpaw_open_tab / foxpaw_close_tab / foxpaw_activate_tab / foxpaw_find_tabs |
| cdp / cdpEndpoint | foxpaw_cdp / foxpaw_cdp_endpoint（都需要主人给的「原始 CDP」授权） |
| ask | foxpaw_need_human |
| requestElevation | foxpaw_request_elevation |
| listTasks / taskAccept / taskProgress / taskResult | foxpaw_list_tasks / foxpaw_task_accept / foxpaw_task_progress / foxpaw_task_result |
| flowRun | foxpaw_flow_run（回放流程；付款 / 授权 / 密码、验证码、卡号停下交主人） |

注意：WS 的 `fill` 默认只描边不填（`dryRun` 默认 true）；MCP `foxpaw_fill` 默认真填。

完整的工具说明见接入说明：`/agent-guide`。
