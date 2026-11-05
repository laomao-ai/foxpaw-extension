# 参与 FoxPaw / Contributing

谢谢你愿意帮忙！

## 现阶段

- **欢迎提 Issue**：Bug、功能建议、网站兼容问题都有模板，照着填就好。
- **Pull Request**：现阶段我们主要接收 Issue。PR 也欢迎，但可能合并较慢；较大的改动请先开 Issue 讨论。
- 提交 PR 即表示你同意你的贡献以本仓库的 [MIT 许可证](LICENSE) 发布。是否需要签署贡献者说明（如 DCO 的 `Signed-off-by`）目前为**可选**，以后如有变化会在这里说明。

## 提 Issue 前

- **不要贴出**令牌、邀请链接、配对码、密码、Cookie；截图请打码。
- 安全漏洞请走 [SECURITY.md](SECURITY.md)，不要公开提。
- 写上扩展版本（侧栏底部）、Chrome 版本、所用的 Agent / MCP 客户端。

## 改扩展

扩展是纯 JavaScript（Manifest V3），没有构建步骤：在 `chrome://extensions` 打开开发者模式，「加载已解压的扩展程序」选 `extension/` 目录，改完点刷新即可。请保持现有代码风格，不引入第三方依赖。

---

Issues are welcome (templates provided). PRs are accepted but may be merged slowly; please open an issue first for larger changes. By submitting a PR you agree to license your contribution under the MIT License. A `Signed-off-by` line is optional for now.
