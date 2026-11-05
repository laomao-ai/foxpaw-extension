<div align="center"><a name="readme-top"></a>

<img src="docs/images/banner.png" alt="FoxPaw · 狐爪：云端的大脑，本地的手。把你正在用的浏览器，借给你所有的 Agent" width="100%">

<h1>FoxPaw · 狐爪</h1>

**一个账号，连起你每台电脑上已登录的 Chrome，借给你所有的 Agent。**

[English](README.md) · **简体中文** · [官网](https://foxpaw.aiyuancat.com) · [Agent 接入说明](docs/agent-guide.md) · [更新日志](CHANGELOG.md) · [反馈](https://github.com/laomao-ai/foxpaw-extension/issues)

[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![Release](https://img.shields.io/github/v/release/laomao-ai/foxpaw-extension?color=f2641a)](https://github.com/laomao-ai/foxpaw-extension/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/laomao-ai/foxpaw-extension?style=flat&color=f2641a)](https://github.com/laomao-ai/foxpaw-extension/stargazers)
[![Works with MCP](https://img.shields.io/badge/works%20with-MCP-6e56cf)](docs/agent-guide.md)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](extension/)
[![官网](https://img.shields.io/badge/%E5%AE%98%E7%BD%91-foxpaw.aiyuancat.com-f2641a)](https://foxpaw.aiyuancat.com)

</div>

FoxPaw 是一个 Chrome 扩展。家里、公司、异地的每台电脑装上它、登同一个账号，你所有的 Agent，不管跑在云端还是你自己电脑上（云端托管的助手、编程 Agent、IDE……），只要支持 MCP，都能通过托管中继用这些电脑上的真实 Chrome，各干各的，只在你授权的标签页里看页面、填表单、点按钮、录制和回放流程。不用重新登录：你在哪个网站登录着，它就能在那儿干活；你没登录的，它也进不去。付款每次等你批。

<!-- 演示动图位（之后补录屏）：docs/images/demo.gif，约 20 秒：Agent 在授权标签里读订单列表 → 侧栏弹批准卡 → 你点批准。 -->

## 它能帮你做什么

| | 以前 | 现在 |
|---|---|---|
| **云端 Agent 借你已登录的浏览器** | 让云端 Agent 看一眼闲鱼上的咨询：它在机房里开自己的浏览器，页面打不开，换个入口要登录，登录完要验证，再来一个滑块。发 X 也一样，它换着 IP 登你的号，最容易被风控盯上。 | 闲鱼、X 本来就在你电脑的 Chrome 里登录着。把那一页拖进 FoxPaw 标签组，云端 Agent 就在这一页里读咨询、回消息、发帖。不用在云端再登录一遍，也不在陌生机器上留下你的登录；滑块、拼图这类验证，它会举手交给你。 |
| **多台电脑、多个 Agent，互不打扰、接着干** | 每个 Agent 各开各的浏览器、各登一遍。云端做不了的几步先让本地 AI 做完，再交回云端，同一件事讲两遍。 | 家里、公司的电脑登同一个账号，云端、本地的 Agent 都能接进来，各干各的。同一个标签同一时刻只有一个 Agent 能动手，谁在用哪台电脑的哪一页，侧栏上看得见。公司电脑开着，回到家 Agent 照样能接着操作那台电脑上的页面，不用再跟它从头讲一遍任务。 |
| **它会问你，付款等你批** | 要么一直盯着屏幕，要么放手让它点，心里没底。 | 提交、删除先弹卡问你；付款、订阅、升级每次都弹卡并标明金额，你批准了它才点，拒绝就不点。要你出手的事，它会在侧栏举手说清楚，等你回一句再接着做。开了飞书通知，同一张卡推到手机上，不在电脑前也能批。 |
| **录一次，换 Agent、换设备都能用** | 每次都让 AI 重新摸一遍网站，同样的坑再踩一遍，同样的 token 再花一遍。 | 让 Agent 自己开录（或你演示一遍），存成流程。比如一个叫 Foxe 的 Agent 把「在 GitHub 建仓库」录成 15 步的流程，仓库名设成填写项，以后哪个 Agent、在哪台电脑上要建仓库，换个名字就能重跑。网站的入口和坑记成站点经验，你收下后，你的其他 Agent 都能先读再动手；流程也能定时跑、导出回放脚本。 |

## 看一眼

| 控制台 | 敏感动作先问你 |
|---|---|
| ![控制台概览](docs/images/console-overview.png) | ![批准卡](docs/images/approval-card.png) |
| **邀请 Agent：默认只看、不授权任何浏览器** | **官网** |
| ![邀请弹窗](docs/images/invite-readonly.png) | ![官网首页](docs/images/site-home.png) |

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

## 隐私与授权

写进系统里的规矩，不是口头承诺：

1. **浏览器留在你本机**：Cookie 和你在 FoxPaw 里存的登录凭证都留在你电脑上（凭证加密存在扩展里），中继只负责转发。
2. **付款每次都要你批准**：点付款、订阅、升级前每次弹卡等你批准（标明金额），不会被记住或放行；卡号、支付密码一律由你来填。
3. **密码、验证码等默认由你来，除非你主动信任某个 Agent**：信任后它才能用你存的登录凭证登录，此时也由扩展在本机填入，Agent 看不到密码，回读只显示 `•••`。人机验证永远交给你。
4. **标签组就是授权边界**：只有拖进 FoxPaw 标签组的标签，Agent 才能看和操作；组外页面它看不见、碰不到，要用必须当场向你申请。新邀请的 Agent 默认不授权任何浏览器、权限默认「只看」；每个 Agent 单独设置能看 / 能操作、信任范围（某站 / 全部网站 / 本次放行），原始 CDP 模式需单独授权。
5. **改东西之前先问你**：提交、删除、授权先弹审批卡，你批准了才执行；一键「全部暂停」随时让所有 Agent 停手。
6. **凭证归你管**：每台设备、每个 Agent 一份独立令牌，中继只存哈希；在控制台随时改名、断开、吊销，立即生效。
7. **录制先脱敏**：录下的流程上云前去掉凭据和你输入的秘密值；Agent 提交的草稿流程和站点经验要你收下才生效。

扩展申请的浏览器权限及用途：`tabs` / `tabGroups`（识别授权标签组）、`scripting` / `debugger`（在授权标签里读页和操作）、`webRequest`（只观察不拦截，用于判断页面加载是否完成）、`storage`（本机设置与加密保存的登录凭证）、`notifications` / `sidePanel` / `alarms` / `webNavigation` / `activeTab`（侧栏、提醒、导航状态）。源码都在 [extension/](extension/)，欢迎审阅。

## 常见问题

<details>
<summary><b>要钱吗？</b></summary>

客户端代码 MIT 开源，可自由使用修改。官方托管服务公测期免费，可能设用量上限；未来可能推出付费方案，并会提前公告。不提供 SLA。
</details>

<details>
<summary><b>FoxPaw 或中继能看到我的密码和 Cookie 吗？</b></summary>

中继不保存这些。页面操作都在你本机的浏览器里发生，Cookie 和你存在 FoxPaw 里的登录凭证留在你电脑上；中继只负责转发和权限记账。你主动信任的 Agent 可以用存好的凭证登录，但由扩展在本机填入，Agent 只看到 `•••`。
</details>

<details>
<summary><b>支持哪些 Agent？</b></summary>

云端、本地都行：凡是支持 MCP（HTTP 方式，或通过 stdio 桥接）的 Agent，比如云端托管的 Agent、Claude Code、Codex、Cursor、VS Code 等，现成配置见 [examples/](examples/)。
</details>

<details>
<summary><b>能连几台电脑？Agent 用哪台？</b></summary>

家里、公司、异地的电脑都行：每台的 Chrome 装上扩展、登同一个 FoxPaw 账号配对一次，就出现在控制台「设备」里，每台可以单独改名、断开、吊销。Agent 能用哪几台由你在控制台选；它接入后用 `foxpaw_whoami` 就能看到自己能用的电脑和标签。
</details>

<details>
<summary><b>Agent 控浏览器的工具已经很多了，FoxPaw 有什么不同？</b></summary>

我们不比谁点得更花，比的是用谁的浏览器。云端 Agent 自带的浏览器在机房里，是没登录的，会卡在登录页、短信验证码、「新设备登录」和风控上；本地每个工具又各开各的浏览器。FoxPaw 把你平时正在用、已经登录好的 Chrome 共享给你所有的 Agent：一个账号连起家里、公司每台电脑，多个 Agent 各干各的、接着干；只在你授权的标签里动手，敏感动作先弹卡问你。
</details>

<details>
<summary><b>两个 Agent 能在浏览器里聊天吗？</b></summary>

能，算个彩蛋。把两个 Agent 的聊天网页都拖进 FoxPaw 标签组，让其中一个去另一个的输入框里打字、读回复，它们就聊起来了。我们试过：一个发「测试消息，不用回复」，对面回「收到，发送链路是通的。」
</details>

<details>
<summary><b>能自己部署中继吗？</b></summary>

暂时不能，中继服务端暂不开源。本仓库的扩展完全开源，也可以以独立扩展身份运行（见下文「关于 manifest.json 里的 key」）。
</details>

## 开源与免费边界

- 客户端代码 MIT 开源，可自由使用修改。
- 官方托管服务公测期免费，可能设用量上限；未来可能推出付费方案，并会提前公告。
- 不提供 SLA。
- 中继服务端暂不开源。

**架构一句话**：浏览器扩展（本仓库，MIT 开源）↔ 托管中继服务（由艾元猫工作室运营，`foxpaw.aiyuancat.com`）↔ 你的 Agent（标准 MCP）。中继只负责转发和权限记账，页面操作都在你本机的浏览器里发生。

## 功能一览

- **读页与操作**：页面快照（带稳定 ref）、点击、填表（含下拉、日期、上传）、等待条件、滚动加载、批量抽取、只读 DOM 查询、截图、多步批处理。
- **录制成流程**：你演示一遍，或让 Agent 照目标做一遍，都能沉淀成可回放的流程；回放失败会暂停等你处理。
- **站点经验**：Agent 把某个网站的入口、坑、注意事项留成经验，你收下后，你的其他 Agent 也能用上。
- **多 Agent、多设备**：家里、公司、异地的电脑登同一个账号，每台独立吊销；多个 Agent 同时接入，谁在干活、谁在等你一目了然。
- **需要你时举手**：登录、验证码、二次确认等只有你能做的事，Agent 会举手等你。

## 仓库结构

```
extension/   Chrome 扩展源码（Manifest V3，1.33.2）
docs/        Agent 接入说明、旧版迁移说明（线上公开版本的副本）、README 图片
examples/    各 MCP 客户端配置示例、领取令牌示例
CHANGELOG.md 对外版本要点
SECURITY.md  安全问题报告方式
CONTRIBUTING.md 参与方式
```

扩展源码不含第三方代码或依赖，无需构建，直接「加载已解压的扩展程序」即可。

### 关于 manifest.json 里的 `key`

`extension/manifest.json` 保留了 `key` 字段。它是扩展的**公钥**（不是私钥，不泄露任何秘密），作用是让你自己加载本仓库源码时得到的扩展 ID 与官方发布包一致，这样「检查更新」、已有配对和托管中继对扩展的识别都能照常工作。如果你想以独立扩展的身份运行（例如改名自用、避免与官方包冲突），删掉 `key` 这一行即可，Chrome 会按文件夹路径生成新的扩展 ID，然后重新连接一次浏览器。

## 参与与安全

- Bug、功能建议、网站兼容问题：请用 [Issues](https://github.com/laomao-ai/foxpaw-extension/issues)（已提供模板），参与方式见 [CONTRIBUTING.md](CONTRIBUTING.md)
- 安全漏洞：请勿公开提 Issue，按 [SECURITY.md](SECURITY.md) 私下报告

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=laomao-ai/foxpaw-extension&type=Date)](https://star-history.com/#laomao-ai/foxpaw-extension&Date)

<div align="right"><a href="#readme-top">回到顶部 ↑</a></div>
