# FoxPaw · 狐爪

**让你的 AI 助手借用你的浏览器干活：借的是登录态，永远不交密码。**

FoxPaw 是一个 Chrome 扩展。任何支持 MCP 的 AI 助手（Claude Code、Codex、Cursor 等）通过托管中继连到你本机的真实 Chrome，只在你授权的标签页里看页面、填表单、点按钮、录制和回放流程；付款、删除、提交这类敏感动作先弹卡，等你点头。

- 官网：https://foxpaw.aiyuancat.com
- Agent 接入说明：https://foxpaw.aiyuancat.com/docs（本仓库副本见 [docs/agent-guide.md](docs/agent-guide.md)）
- 许可证：MIT（[LICENSE](LICENSE)）

**架构一句话**：浏览器扩展（本仓库，MIT 开源）↔ 托管中继服务（由艾元猫工作室运营，`foxpaw.aiyuancat.com`）↔ 你的 Agent（标准 MCP）。中继只负责转发和权限记账，页面操作都在你本机的浏览器里发生。

---

## 30 秒上手

1. **装扩展**：从 [官网下载](https://foxpaw.aiyuancat.com/download/extension) 或用本仓库 [extension/](extension/) 目录 → 打开 `chrome://extensions` → 右上角开「开发者模式」→「加载已解压的扩展程序」选中文件夹。
2. **连浏览器**：点扩展侧栏「连接这台浏览器」，用邮箱验证码登录并确认；把要给 Agent 用的标签拖进 FoxPaw 标签组。
3. **邀请 Agent**：控制台「接入 Agent」→ 生成邀请（自动复制）→ 粘给你的 Agent。它会照 [接入说明](https://foxpaw.aiyuancat.com/docs) 自己领令牌、配好 MCP。

需要手动配置时，各客户端写法见 [examples/](examples/)，核心就两样：

```json
{
  "mcpServers": {
    "foxpaw": {
      "type": "http",
      "url": "https://foxpaw.aiyuancat.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## 隐私与最小授权

写进系统里的规矩，不是口头承诺：

1. **借登录态，不交密码**：密码和 Cookie 不离开你的电脑。Agent 用你存的登录凭证登录时看不到密码，扩展在本机填入，回读只显示 `•••`。
2. **标签组就是授权边界**：只有拖进 FoxPaw 标签组的标签，Agent 才能看和操作；组外页面它看不见、碰不到，要用必须当场向你申请。
3. **默认最小权限**：从控制台概览快捷邀请的 Agent 默认不授权任何浏览器，接入后由你按需授权；每个 Agent 单独设置能看 / 能操作、信任范围（某站 / 全部网站 / 本次放行），原始 CDP 模式需单独授权。
4. **敏感动作先确认**：付款、授权、删除、提交先弹审批卡；付款页和支付密码框永远由你亲手完成；人机验证永远交给你。一键「全部暂停」随时让所有 Agent 停手。
5. **凭证归你管**：每台设备、每个 Agent 一份独立令牌，中继只存哈希；在控制台随时改名、断开、吊销，立即生效。
6. **录制先脱敏**：录下的流程上云前去掉凭据和你输入的秘密值；Agent 提交的草稿流程和站点经验要你收下才生效。

扩展申请的浏览器权限及用途：`tabs` / `tabGroups`（识别授权标签组）、`scripting` / `debugger`（在授权标签里读页和操作）、`webRequest`（只观察不拦截，用于判断页面加载是否完成）、`storage`（本机设置与加密保存的登录凭证）、`notifications` / `sidePanel` / `alarms` / `webNavigation` / `activeTab`（侧栏、提醒、导航状态）。源码都在 [extension/](extension/)，欢迎审阅。

## 免费与边界

- 客户端代码 MIT 开源，可自由使用修改。
- 官方托管服务公测期免费，可能设用量上限；未来可能推出付费方案，并会提前公告。
- 不提供 SLA。
- 中继服务端暂不开源。

## 它能做什么

- **读页与操作**：页面快照（带稳定 ref）、点击、填表（含下拉、日期、上传）、等待条件、滚动加载、批量抽取、只读 DOM 查询、截图、多步批处理。
- **录制成流程**：你演示一遍，或让 Agent 照目标做一遍，都能沉淀成可回放的流程；回放失败会暂停等你处理。
- **站点经验**：Agent 把某个网站的入口、坑、注意事项留成经验，你收下后，你的其他 Agent 也能用上。
- **多 Agent、多设备**：几台电脑连到同一个账户，每台独立吊销；多个 Agent 同时接入，谁在干活、谁在等你一目了然。
- **需要你时举手**：登录、验证码、二次确认等只有你能做的事，Agent 会举手等你。

## 仓库结构

```
extension/   Chrome 扩展源码（Manifest V3，1.33.1）
docs/        Agent 接入说明、旧版迁移说明（线上公开版本的副本）
examples/    各 MCP 客户端配置示例、领取令牌示例
CHANGELOG.md 对外版本要点
SECURITY.md  安全问题报告方式
CONTRIBUTING.md 参与方式
```

扩展源码不含第三方代码或依赖，无需构建，直接「加载已解压的扩展程序」即可。

### 关于 manifest.json 里的 `key`

`extension/manifest.json` 保留了 `key` 字段。它是扩展的**公钥**（不是私钥，不泄露任何秘密），作用是让你自己加载本仓库源码时得到的扩展 ID 与官方发布包一致，这样「检查更新」、已有配对和托管中继对扩展的识别都能照常工作。如果你想以独立扩展的身份运行（例如改名自用、避免与官方包冲突），删掉 `key` 这一行即可，Chrome 会按文件夹路径生成新的扩展 ID，然后重新连接一次浏览器。

## 反馈

- Bug、功能建议、网站兼容问题：请用 Issues（已提供模板）
- 安全漏洞：请勿公开提 Issue，按 [SECURITY.md](SECURITY.md) 私下报告

---

## English

**FoxPaw lets your AI agent borrow your real, logged-in Chrome: it uses your sessions, never your passwords.**

FoxPaw is a Chrome extension (this repository, MIT-licensed). Any MCP-capable agent (Claude Code, Codex, Cursor, …) reaches the Chrome on your own machine through a hosted relay operated by 艾元猫工作室 (Aiyuanmao Studio) and works only inside the tabs you put in the FoxPaw tab group. Sensitive actions (payments, authorizations, deletes, submits) wait for your approval; payment fields and human-verification checks are always left to you.

**Quick start:** load `extension/` via `chrome://extensions` → Developer mode → "Load unpacked"; click "Connect this browser" in the side panel and sign in with an email code; invite your agent from the console. Manual MCP configs for common clients are in [examples/](examples/): the endpoint is `https://foxpaw.aiyuancat.com/mcp` with `Authorization: Bearer <token>`.

**Privacy:** passwords and cookies never leave your machine; agents invited with the console's quick invite get no browser access until you grant it; per-device and per-agent tokens are stored hashed on the relay and can be revoked at any time.

**Free use and limits:** the client code is MIT-licensed and free to use and modify. The official hosted relay is free during the public beta and may have usage limits; paid plans may be introduced later with advance notice. No SLA is provided. The relay server is not open source at this time.

Agent guide (Chinese): https://foxpaw.aiyuancat.com/docs · Security reports: see [SECURITY.md](SECURITY.md).
