#!/usr/bin/env bash
#
# 在目标服务器上执行。默认只打印将要做什么，必须显式 --apply 才动手。
#
#   bash scripts/onboard-server.sh                 # 预演
#   sudo bash scripts/onboard-server.sh --apply     # 执行
#
# 幂等：重复执行不会破坏已经就绪的部分。
set -euo pipefail

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
DIR=/opt/agentgate
REPO=https://github.com/ciceroyang/agentgate

run() {
  if [ "$APPLY" = "1" ]; then echo "+ $*"; "$@"; else echo "  would run: $*"; fi
}

echo "== 目标环境 =="
echo "  host:    $(hostname)"
echo "  system:  $(uname -srm)"
echo "  user:    $(id -un)"
echo "  target:  $DIR"
echo "  mode:    $([ "$APPLY" = "1" ] && echo APPLY || echo DRY-RUN)"
echo

echo "== 检查项 =="
if command -v docker >/dev/null 2>&1; then echo "  docker:  已安装 ($(docker --version | cut -d, -f1))"; else echo "  docker:  未安装 -> 将安装"; fi
if command -v git >/dev/null 2>&1; then echo "  git:     已安装"; else echo "  git:     未安装 -> 将安装"; fi
if [ -d "$DIR/.git" ]; then echo "  repo:    已存在 -> 将更新"; else echo "  repo:    不存在 -> 将克隆"; fi
if command -v caddy >/dev/null 2>&1; then echo "  caddy:   已安装 (TLS 将自动签发)"; else echo "  caddy:   未安装 -> 如需对外 HTTPS 请安装"; fi
echo "  备案:    中国大陆机器必须已备案才能使用 80/443（见 docs/operations/what-i-need.md）"
echo

echo "== 将执行 =="
if ! command -v docker >/dev/null 2>&1; then
  run apt-get update
  run apt-get install -y docker.io docker-compose-v2 git curl
  run systemctl enable --now docker
fi
if [ ! -d "$DIR/.git" ]; then
  run mkdir -p "$DIR"
  run git clone "$REPO" "$DIR"
else
  run git -C "$DIR" pull --ff-only
fi
echo "  then: cd $DIR && docker compose --profile collect run --rm refresh   # 首次全量采集，约十分钟"
echo "  then: cd $DIR && docker compose up -d agentgate"
echo "  then: node scripts/smoke.mjs http://127.0.0.1:8080                    # 部署后检查"
echo

echo "== 我接下来会看的 =="
echo "  - data/index.json 的 generatedAt 是不是当天"
echo "  - records 是不是几千条，而不是样本的 300 条"
echo "  - data/history/ 有没有生成第一份快照与 diff"
echo
if [ "$APPLY" != "1" ]; then
  echo "这是预演。确认无误后加 --apply 执行。"
fi
