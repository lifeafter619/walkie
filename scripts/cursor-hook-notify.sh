#!/bin/sh
# Cursor hook → Walkie 通知转发脚本（POSIX sh，macOS/Linux 通用；Windows 用 Git Bash）。
#
# Cursor 的 hook 只有 command 类型（无原生 HTTP），所以用这段脚本把事件 JSON
# 转发到 Walkie 的 Claude hook 端点——事件字段与 Claude Code 高度同构，
# 服务端按同一套映射翻译（stop→success、失败→critical、等待输入→critical）。
#
# 用法：
#   1. 把本脚本放到项目里（如 .cursor/hooks/walkie-notify.sh）并 chmod +x
#   2. 在 .cursor/hooks.json 里挂到 stop / sessionEnd / postToolUseFailure 事件
#   3. 设置环境变量（或直接改下面两行）：
#      WALKIE_URL   — Walkie 实例地址，如 https://walkie.example.com
#      WALKIE_TOKEN — Agent Key（建议为 hook 单独建一个 key，绑定一个目的地）
#
# 脚本永远 exit 0：通知失败不能阻塞 Cursor 的正常工作流。

stdin_payload=$(cat)

url="${WALKIE_URL:-https://walkie.example.com}"
token="${WALKIE_TOKEN:-}"

if [ -z "$token" ] || [ "$url" = "https://walkie.example.com" ]; then
  # 未配置时静默退出——hook 脚本会在没配 Walkie 的机器上被拉起（hooks.json 随仓库走）
  exit 0
fi

# timeout 10s：curl 卡住不能拖住 Cursor（hook 默认 30s 超时，留足余量）
curl -fsS --max-time 10 \
  -X POST "$url/api/v1/hooks/claude${WALKIE_DESTINATION:+?destination=$WALKIE_DESTINATION}" \
  -H "authorization: Bearer $token" \
  -H 'content-type: application/json' \
  -d "$stdin_payload" >/dev/null 2>&1 || true

exit 0
