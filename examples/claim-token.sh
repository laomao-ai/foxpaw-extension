#!/usr/bin/env bash
# 用主人给的邀请码领取 Agent 令牌（令牌只返回这一次，请妥善保存）。
# 用法: ./claim-token.sh <邀请码> <你在主人面板上显示的名字>
set -euo pipefail
INVITE="${1:?需要邀请码（邀请链接 ...?invite=<邀请码> 里的那段）}"
LABEL="${2:?需要显示名字}"
curl -sS -X POST https://foxpaw.aiyuancat.com/auth/agent/claim \
  -H 'Content-Type: application/json' \
  -d "$(printf '{"invite":"%s","label":"%s"}' "$INVITE" "$LABEL")"
echo
# 回包里的 config_snippet 就是可直接写进 MCP 客户端的 mcpServers 配置。
