<div align="center"><a name="readme-top"></a>

<img src="docs/images/banner.png" alt="FoxPaw — Cloud brain, local hands. Lend your real browser to every agent you use." width="100%">

<h1>FoxPaw</h1>

**One account. The signed-in Chrome on every computer you use, lent to every agent you run.**

**English** · [简体中文](README.zh-CN.md) · [Website](https://foxpaw.aiyuancat.com) · [Agent guide](docs/agent-guide.md) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/laomao-ai/foxpaw-extension/issues)

[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![Release](https://img.shields.io/github/v/release/laomao-ai/foxpaw-extension?color=f2641a)](https://github.com/laomao-ai/foxpaw-extension/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/laomao-ai/foxpaw-extension?style=flat&color=f2641a)](https://github.com/laomao-ai/foxpaw-extension/stargazers)
[![Works with MCP](https://img.shields.io/badge/works%20with-MCP-6e56cf)](docs/agent-guide.md)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](extension/)
[![Website](https://img.shields.io/badge/website-foxpaw.aiyuancat.com-f2641a)](https://foxpaw.aiyuancat.com)

</div>

FoxPaw is a Chrome extension. Install it on every computer you use — at home, at work, anywhere — and sign in to the same account. Every agent you run, in the cloud or on your own computer — anything that speaks MCP, from hosted assistants to coding agents and IDEs — connects through a hosted relay to the real Chrome on those computers, side by side, and works only inside the tabs you hand it: reading pages, filling forms, clicking buttons, recording and replaying flows. No re-login: sites you are logged in to just work; sites you are not, it can't get into either. Payments always need your approval.

<!-- Demo GIF goes here (screen recording to be added): docs/images/demo.gif, ~20 s: agent reads an order list in an authorized tab → approval card pops up → user approves. -->

## What it can do for you

| | Before | With FoxPaw |
|---|---|---|
| **Cloud agents borrow the browser you're already logged in to** | Ask a cloud agent to check messages on a marketplace account: it opens its own browser in a data center, the site won't load from abroad, then wants a login, then a verification code, then a slider. Posting to X is the same story — logging in to your account from rotating IPs is exactly what trips risk controls. | Those sites are already logged in in your own Chrome. Drag that tab into the FoxPaw tab group and the cloud agent reads, replies and posts right there. No second login in the cloud, no trace of your login left on a stranger's machine; slider and puzzle checks are handed back to you. |
| **Every computer, every agent — no collisions, seamless hand-off** | Every agent opens its own browser and logs in again. The steps the cloud agent can't do go to a local AI first, then back to the cloud — and you explain the task twice. | Your home and work computers sign in to one account, and cloud and local agents all connect, each doing its own work. Only one agent can act on a tab at a time, and the side panel shows who is using which page on which computer. Leave the office computer on and, back home, your agent keeps working on that computer — no need to brief it again. |
| **It asks you; payments wait for your OK** | Either watch the screen the whole time, or let it click and hope. | Submits and deletes ask you on a card first; every payment, subscription or upgrade gets a card with the amount, every time — it clicks only after you approve. When it needs your hands, it raises a hand in the side panel and waits for your reply. With Feishu notifications on, the same card reaches your phone. |
| **Record once, reuse with any agent on any device** | Every time, the AI explores the site from scratch, hits the same traps and burns the same tokens. | Let the agent record itself (or demonstrate once) and save it as a flow. For example, an agent named Foxe recorded "create a GitHub repository" as a 15-step flow with the repo name as a fill-in field — any agent, on any of your computers, reruns it with a new name. Entry points and traps become site notes your other agents read before they start; flows can also run on a schedule or be exported as a replay script. |

## See it

| Console | Sensitive actions ask you first |
|---|---|
| ![Console overview](docs/images/console-overview.png) | ![Approval card](docs/images/approval-card.png) |
| **Invite an agent: read-only, no browser granted by default** | **Website** |
| ![Invite dialog](docs/images/invite-readonly.png) | ![Website home](docs/images/site-home.png) |

## Quick start (30 seconds)

1. **Install the extension** — download from the [website](https://foxpaw.aiyuancat.com/download/extension) or use [`extension/`](extension/) in this repo → open `chrome://extensions` → turn on *Developer mode* → *Load unpacked* and pick the folder.
2. **Connect the browser** — in the side panel click *Connect this browser*, sign in with an email code and confirm; drag the tabs your agent may use into the FoxPaw tab group.
3. **Invite your agent** — console → *Connect agent* → generate an invite (copied automatically) → paste it to your agent. It follows the [agent guide](https://foxpaw.aiyuancat.com/docs) to claim its token and configure MCP itself.

Manual setup for each client is in [`examples/`](examples/); the core is just this:

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

## Privacy and permissions

Rules built into the system, not promises:

- **Your browser stays on your machine.** Cookies and the logins you save in FoxPaw stay on your computer (saved logins are encrypted in the extension); the relay only forwards calls.
- **Payments always need your approval.** Every payment, subscription or upgrade click asks you on a card first (amount shown), every time; card numbers and payment passwords are always yours to type.
- **Passwords and verification codes are yours by default** — unless you choose to trust a specific agent with saved logins; even then the extension fills them locally and the agent only ever sees `•••`. Human-verification checks are always left to you.
- **The tab group is the boundary.** The agent can only see and act in tabs you put in the FoxPaw tab group. A newly invited agent gets no browser at all and starts read-only; you grant more per agent.
- **Ask before changing things.** Submits, deletes and authorizations pop up an approval card; *Pause all* stops every agent at once.
- **Your tokens, your control.** One token per device and per agent, stored hashed on the relay; rename, disconnect or revoke any time, effective immediately.

Browser permissions and why: `tabs` / `tabGroups` (find the authorized tab group), `scripting` / `debugger` (read and act in authorized tabs), `webRequest` (observe only, never block, to tell when a page finished loading), `storage` (local settings and encrypted saved logins), `notifications` / `sidePanel` / `alarms` / `webNavigation` / `activeTab` (side panel, reminders, navigation state). The full source is in [`extension/`](extension/) — no third-party code, no build step.

## FAQ

<details>
<summary><b>Is it free?</b></summary>

The client code is MIT-licensed and free to use and modify. The official hosted relay is free during the public beta and may have usage limits; paid plans may be introduced later with advance notice. No SLA is provided.
</details>

<details>
<summary><b>Can FoxPaw or the relay see my passwords or cookies?</b></summary>

The relay does not store them. Page actions happen in your own Chrome; cookies and the logins you save in FoxPaw stay on your machine. The relay only forwards calls and keeps permission records. An agent you choose to trust can sign in with a saved login, but the extension types it locally and the agent only sees `•••`.
</details>

<details>
<summary><b>Which agents work with it?</b></summary>

Cloud or local — any agent that speaks MCP over HTTP (or via the stdio bridge), for example hosted agents, Claude Code, Codex, Cursor or VS Code. Ready-made configs are in [`examples/`](examples/).
</details>

<details>
<summary><b>How many computers can I connect, and which one does an agent use?</b></summary>

Home, work, anywhere: install the extension in Chrome on each computer and pair it with the same FoxPaw account. Each one shows up under *Devices* in the console, where you can rename, disconnect or revoke it on its own. You choose which computers each agent may use; once connected, an agent calls `foxpaw_whoami` to see the computers and tabs it can work in.
</details>

<details>
<summary><b>There are plenty of tools that let agents drive a browser. What's different?</b></summary>

We don't compete on fancier clicking — the difference is whose browser. A cloud agent's own browser lives in a data center and isn't logged in, so it stalls on login pages, SMS codes, "new device" alerts and risk controls; local tools each open yet another browser. FoxPaw shares the Chrome you already use, logged in, with all your agents: one account connects every computer you use, agents work side by side, seamless hand-off — acting only inside the tabs you authorize, with sensitive actions asking you first.
</details>

<details>
<summary><b>Can two agents chat with each other in my browser?</b></summary>

Yes — a little easter egg. Drag both agents' chat pages into the FoxPaw tab group and have one type into the other's input box and read the reply. We tried it: one sent "test message, no need to reply", the other answered "Got it, the send path works."
</details>

<details>
<summary><b>Can I self-host the relay?</b></summary>

Not at the moment: the relay server is not open source. The extension in this repo is fully open, and you can run it as an independent extension (see the note on `key` in the [Chinese README](README.zh-CN.md#关于-manifestjson-里的-key)).
</details>

## Open source and limits

- The client code is MIT-licensed and free to use and modify.
- The official hosted relay is free during the public beta and may have usage limits; paid plans may be introduced later with advance notice.
- No SLA is provided.
- The relay server is not open source at this time; it is operated by 艾元猫工作室 (Aiyuanmao Studio) at `foxpaw.aiyuancat.com`.

**Architecture in one line:** browser extension (this repo, MIT) ↔ hosted relay ↔ your agent (standard MCP). The relay only forwards and keeps permission records; page actions happen in your own browser.

## Contributing and security

- Bugs, feature requests, site compatibility: [Issues](https://github.com/laomao-ai/foxpaw-extension/issues) (templates provided). See [CONTRIBUTING.md](CONTRIBUTING.md).
- Security vulnerabilities: please don't open a public issue — report privately as described in [SECURITY.md](SECURITY.md).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=laomao-ai/foxpaw-extension&type=Date)](https://star-history.com/#laomao-ai/foxpaw-extension&Date)

<div align="right"><a href="#readme-top">Back to top ↑</a></div>
