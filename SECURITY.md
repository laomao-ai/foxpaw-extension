# 安全策略 / Security Policy

FoxPaw 让外部 Agent 操作你的真实浏览器，安全问题我们会优先处理。

## 报告漏洞

**请不要在公开 Issue 里提交安全漏洞。** 请发邮件到 **foxpaw@aiyuancat.com**（标题注明「安全」），或通过本仓库 **Security → Report a vulnerability** 私密提交（GitHub 私密漏洞报告），只有维护者能看到。

报告里请尽量包含：

- 受影响的组件与版本（扩展版本见侧栏「我」页，如「FoxPaw 内测版 1.34」，悬停可看完整版本号；中继版本见 `https://foxpaw.aiyuancat.com/health`）
- 复现步骤或概念验证
- 影响范围（例如：越过标签组边界、绕过审批卡、读到秘密字段、令牌泄露等）
- 你希望如何署名（可匿名）

我们会尽快确认收到，并在修复后告知你。请在修复发布前不要公开细节。

## 范围

- 本仓库的 Chrome 扩展源码
- 官方托管中继服务 `foxpaw.aiyuancat.com` 的公开接口（MCP、令牌领取、设备配对）

请不要对其他用户的账户、设备或数据进行测试，不要进行拒绝服务类测试。

## 如果你的令牌泄露了

在控制台「Agent」或「设备」里吊销对应令牌，再重新邀请 / 配对即可；吊销立即生效。

---

**Please do not report security vulnerabilities through public issues.** Email **foxpaw@aiyuancat.com** (put "security" in the subject) or report it privately via this repository's **Security → Report a vulnerability** (GitHub private vulnerability reporting) with the affected version, reproduction steps and impact. Please give us a chance to fix the issue before disclosing it publicly. Do not test against other users' accounts or data, and do not run denial-of-service tests.

产品反馈（非安全问题）也欢迎发到 foxpaw@aiyuancat.com。 / Product feedback (non-security) is welcome at foxpaw@aiyuancat.com too.
