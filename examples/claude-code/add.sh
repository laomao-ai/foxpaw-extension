#!/usr/bin/env bash
# Claude Code：一条命令添加 FoxPaw（远程 HTTP MCP）。把 <token> 换成你领到的令牌。
# --scope user = 所有项目可用；去掉则只在当前项目。
claude mcp add --transport http --scope user foxpaw https://foxpaw.aiyuancat.com/mcp \
  --header "Authorization: Bearer <token>"
# 检查：claude mcp list
