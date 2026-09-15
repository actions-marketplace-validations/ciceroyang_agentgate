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
MODE=node
for a in "$@"; do
  [ "$a" = "--apply" ] && APPLY=1
  [ "$a" = "--docker" ] && MODE=docker
  [ "$a" = "--node" ] && MODE=node
done
DIR=/opt/agentgate
REPO=https://github.com/ciceroyang/agentgate
# Caddyfile 里 serve 的目录。必须有人创建它，否则主域上线就是一个空页面。
STATIC_DIR=/var/www/zhiliang
DOCS_DIR=/var/www/zhiliang-docs
# 单元文件里写的是绝对路径。手册推荐 nvm，而 nvm 装的 node 不在 /usr/bin，
# 照抄单元文件会让 systemctl 报 "No such file or directory"。所以先测真实路径。
NODE_BIN="$(command -v node 2>/dev/null || echo /usr/bin/node)"

run() {
  if [ "$APPLY" = "1" ]; then echo "+ $*"; "$@"; else echo "  would run: $*"; fi
}

echo "== 目标环境 =="
echo "  host:    $(hostname)"
echo "  system:  $(uname -srm)"
echo "  user:    $(id -un)"
echo "  target:  $DIR"
echo "  mode:    $([ "$APPLY" = "1" ] && echo APPLY || echo DRY-RUN) / path: $MODE"
echo

echo "== 检查项 =="
if command -v docker >/dev/null 2>&1; then echo "  docker:  已安装 ($(docker --version | cut -d, -f1))"; else echo "  docker:  未安装 -> 将安装"; fi
if command -v git >/dev/null 2>&1; then echo "  git:     已安装"; else echo "  git:     未安装 -> 将安装"; fi
if [ -d "$DIR/.git" ]; then echo "  repo:    已存在 -> 将更新"; else echo "  repo:    不存在 -> 将克隆"; fi
if command -v caddy >/dev/null 2>&1; then echo "  caddy:   已安装 (TLS 将自动签发)"; else echo "  caddy:   未安装 -> 如需对外 HTTPS 请安装"; fi
echo "  备案:    中国大陆机器必须已备案才能使用 80/443（见 docs/operations/what-i-need.md）"
echo

if [ "$MODE" = "docker" ]; then
  echo "== 注意 =="
  echo "  Docker 路径未经验证（构建上下文与 CMD 验过，镜像构建本身没有）。"
  echo "  Node + systemd 路径已在公开仓库上完整彩排。可用 --node 切回。"
  echo
fi

echo "== 将执行 =="
if ! command -v git >/dev/null 2>&1; then
  run apt-get update
  run apt-get install -y git curl
fi

if [ "$MODE" = "docker" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    run apt-get update
    run apt-get install -y docker.io docker-compose-v2
    run systemctl enable --now docker
  fi
else
  if command -v node >/dev/null 2>&1; then
    echo "  node:    $(node --version) at $NODE_BIN"
  else
    echo "  node:    未安装 -> 请装 Node 20+（nvm 或 nodesource），不要用发行版自带的旧版本"
    echo "           这一步留给你确认，脚本不替你装运行时"
  fi
fi

if [ ! -d "$DIR/.git" ]; then
  run mkdir -p "$DIR"
  run git clone "$REPO" "$DIR"
else
  run git -C "$DIR" pull --ff-only
fi
if [ "$MODE" = "docker" ]; then
  echo "  then: cd $DIR && docker compose --profile collect run --rm refresh"
  echo "  then: cd $DIR && docker compose up -d agentgate"
else
  run bash -c "cd $DIR && $NODE_BIN bin/agentgate.mjs refresh --max 300"
  # 先把第一份快照落下,明天的定时任务才有可比的对象。第一次不写 diff 是正常的。
  run bash -c "cd $DIR && $NODE_BIN scripts/daily-snapshot.mjs"
fi

# 主域是静态站，由仓库里的构建脚本生成。少了这一步，Caddy 起来也是空的。
run mkdir -p "$STATIC_DIR" "$DOCS_DIR"
if [ -f "$DIR/data/index.json" ] || [ "$APPLY" != "1" ]; then
  run "$NODE_BIN" "$DIR/scripts/build-site.mjs" --index "$DIR/data/index.json" --out "$STATIC_DIR" --name evidence.html --pages "$DIR/site"
  # 证据索引链到样例报告，在线上不能是死链
  run bash -c "$NODE_BIN $DIR/bin/agentgate.mjs check --root $DIR/examples/action-verify --policy $DIR/examples/action-verify/agentgate.policy.json --format html --out $STATIC_DIR/report-sample.html || true"
fi

if [ "$MODE" = "node" ]; then
  run useradd -r -s /usr/sbin/nologin agentgate || true
  run chown -R agentgate:agentgate "$DIR"
  if [ -f "$DIR/deploy/agentgate.service" ]; then
    sed "s#^ExecStart=.*#ExecStart=$NODE_BIN bin/agentgate.mjs serve#" "$DIR/deploy/agentgate.service" > /tmp/agentgate.service.new
  fi
  echo "  unit:    ExecStart=$NODE_BIN bin/agentgate.mjs serve"
  if [ "$APPLY" = "1" ]; then
    install -m 0644 /tmp/agentgate.service.new /etc/systemd/system/agentgate.service
  else
    echo "  would install /etc/systemd/system/agentgate.service (仓库克隆后可生成)"
  fi
  run systemctl daemon-reload
  run systemctl enable --now agentgate
fi

run "$NODE_BIN" "$DIR/scripts/smoke.mjs" http://127.0.0.1:8080 --expect-min 1000
echo

echo "== 我接下来会看的 =="
echo "  - data/index.json 的 generatedAt 是不是当天"
echo "  - records 是不是几千条，而不是样本的 300 条"
echo "  - data/history/ 有没有生成第一份快照与 diff"
echo
if [ "$APPLY" != "1" ]; then
  echo "这是预演。确认无误后加 --apply 执行。"
fi
