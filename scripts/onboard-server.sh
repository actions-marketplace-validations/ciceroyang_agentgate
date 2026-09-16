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
SKIP_NET=0
WITH_CADDY=0
PORT=8080
PORT_SET=0
DIR=/opt/agentgate
REPO=https://github.com/ciceroyang/agentgate
# Caddyfile 里 serve 的目录。必须有人创建它，否则主域上线就是一个空页面。
STATIC_DIR=/var/www/zhiliang
DOCS_DIR=/var/www/zhiliang-docs

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --docker) MODE=docker ;;
    --node) MODE=node ;;
    --skip-network) SKIP_NET=1 ;;
    --with-caddy) WITH_CADDY=1 ;;
    --port) PORT="$2"; PORT_SET=1; shift ;;
    --dir) DIR="$2"; shift ;;
    --repo) REPO="$2"; shift ;;
    --repo=*) REPO="${1#--repo=}" ;;
    --help)
      sed -n "3,8p" "$0"
      echo "  选项: --apply --node|--docker --repo <url> --dir <path> --skip-network"
      exit 0 ;;
    *) echo "未知选项:$1（试试 --help）"; exit 2 ;;
  esac
  shift
done

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

PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG="apt"
elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
elif command -v yum >/dev/null 2>&1; then PKG="yum"
fi
install_pkgs() {
  case "$PKG" in
    apt) run apt-get update; run apt-get install -y "$@" ;;
    dnf) run dnf install -y "$@" ;;
    yum) run yum install -y "$@" ;;
    *) echo "  未识别包管理器,请手动安装:$*" ;;
  esac
}

echo "== 检查项 =="
if command -v docker >/dev/null 2>&1; then echo "  docker:  已安装 ($(docker --version | cut -d, -f1))"; else echo "  docker:  未安装 -> 将安装"; fi
if command -v git >/dev/null 2>&1; then echo "  git:     已安装"; else echo "  git:     未安装 -> 将安装"; fi
if [ -d "$DIR/.git" ]; then echo "  repo:    已存在 -> 将更新"; else echo "  repo:    不存在 -> 将克隆"; fi
if command -v caddy >/dev/null 2>&1; then echo "  caddy:   已安装 (TLS 将自动签发)"; else echo "  caddy:   未安装 -> 如需对外 HTTPS 请安装"; fi
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
    if [ "${NODE_MAJOR:-0}" -ge 20 ] 2>/dev/null; then
      echo "  node:    $(node --version) at $NODE_BIN"
    else
      echo "  node:    $(node --version) —— 太旧,agentgate 需要 20 或更高"
      NODE_PROBLEM=1
    fi
  else
    echo "  node:    未安装 —— agentgate 需要 Node 20 或更高"
    NODE_PROBLEM=1
  fi
  # 没有可用的 node,后面每一步都会以 "not found" 的形式失败。这里停住,并说清怎么装。
  if [ -n "${NODE_PROBLEM:-}" ]; then
    echo "           脚本不替你装运行时。按你的发行版装:"
    if [ "$PKG" = "apt" ]; then
      echo "             curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
      echo "             sudo apt-get install -y nodejs"
    elif [ "$PKG" = "dnf" ] || [ "$PKG" = "yum" ]; then
      echo "             sudo $PKG module install -y nodejs:20/common     # 或按 NodeSource 文档"
    else
      echo "             https://nodejs.org/en/download"
    fi
    if [ "$APPLY" = "1" ]; then
      echo "            --apply 停在这里:没有 node 就没有服务可装。"
      exit 1
    else
      # 预演到这里就够了。继续打印 would run 只会列出跑不起来的命令,反而误导。
      echo "            先装好 node,再回来预演。"
      exit 0
    fi
  fi

echo "  备案:    中国大陆机器必须已备案才能使用 80/443（见 docs/operations/what-i-need.md）"
echo

if [ "$MODE" = "docker" ]; then
  echo "== 注意 =="
  echo "  Docker 路径未经验证（构建上下文与 CMD 验过，镜像构建本身没有）。"
  echo "  Node + systemd 路径已在公开仓库上完整彩排。可用 --node 切回。"
  echo
fi

# 发行版家族决定装包命令。阿里云 ECS 的默认镜像是 Alibaba Cloud Linux(RHEL 系,用 dnf),
# 不是 Ubuntu。写死 apt-get,这一步会在用户的机器上停住。
# SELinux 在 RHEL 系上默认 Enforcing,而 Caddy 是第三方单元,会被挡住。
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
  echo "  SELinux: Enforcing —— Caddy 可能读不了 /var/www、连不上 127.0.0.1:$PORT;"
  echo "           处理命令见 docs/operations/deployment-runbook.md 的 SELinux 一节。"
fi
echo "  包管理器:${PKG:-未识别}"
echo
# 大陆服务器上 github.com 经常连不上,而第一步就是 git clone。先测,别等到一半才发现。
probe() {
  local code="000"
  local out
  out="$(curl -sS -o /dev/null --max-time 6 -w "%{http_code}" "$2" 2>/dev/null || true)"
  [ -n "$out" ] && code="$out"
  case "$code" in
    200|301|302|403|404) echo "  $1: 可达 ($code)" ;;
    000) echo "  $1: 连不上 -> $3" ;;
    *) echo "  $1: 返回 $code" ;;
  esac
}
REPO_HOST="$(printf "%s" "$REPO" | sed -E "s#^[a-z]+://([^/]+)/.*#\1#")"
if [ "$SKIP_NET" = "1" ]; then
  echo "  网络预检:已跳过（--skip-network）"
else
  echo "== 网络预检 =="
  echo "  仓库:$REPO"
  probe "仓库主机 $REPO_HOST" "$REPO" "克隆会失败。换镜像,例如 --repo https://gitee.com/<你的镜像>/agentgate"
  probe "MCP 官方注册表" "https://registry.modelcontextprotocol.io/v0/servers?limit=1" "采集会失败;换个时段重试"
  probe "npm registry" "https://registry.npmjs.org/" "包清单查不到,扫描结果会把它们标成 metadata-unavailable"
fi
echo
# 如果上一轮已经装过这个服务,先停掉再探端口。否则会把自己占用的端口当成"被占用",换一个新端口,
# 而 systemctl enable --now 不会重启已经跑着的单元 —— 新配置就永远不生效。这在第一次重跑时真的发生过。
if command -v systemctl >/dev/null 2>&1; then run systemctl stop agentgate 2>/dev/null || true; fi

# 共享机器上 8080 可能已经有人用了(这台机器上还跑着别的站)。先探,别等采集两分钟再失败。
port_in_use() { ( exec 3<>"/dev/tcp/127.0.0.1/$1" ) 2>/dev/null; }
if [ "$PORT_SET" != "1" ] && port_in_use "$PORT"; then
  for cand in 8081 8090 18080 28080; do
    if ! port_in_use "$cand"; then PORT="$cand"; break; fi
  done
  echo "  端口 8080 已被占用 -> 改用 $PORT(想指定别的用 --port)"
fi
if port_in_use "$PORT"; then
  echo "  注意:端口 $PORT 也被占用,服务可能起不来。换一个: sudo bash $0 --apply --with-caddy --port <空闲端口>"
fi
echo
echo "== 将执行 =="
if ! command -v git >/dev/null 2>&1; then
  install_pkgs git curl
fi

if [ "$MODE" = "docker" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$PKG" = "apt" ]; then
      install_pkgs docker.io docker-compose-v2
    else
      echo "  docker: RHEL 系请按 Docker 官方文档加 docker-ce 仓库,或直接用 --node 路径(已验证)"
    fi
    run systemctl enable --now docker
  fi
fi

# 上一轮把 $DIR chown 给了 agentgate,而这个脚本以 root 跑;git 会以 "dubious ownership"
# 拒绝操作,于是第二次部署时拉不到新代码。这一行让 root 认这个目录。
run git config --global --add safe.directory "$DIR" || true

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
  echo "  unit:    ExecStart=$NODE_BIN bin/agentgate.mjs serve   (AGENTGATE_PORT=$PORT)"
  if [ "$APPLY" = "1" ]; then
    install -m 0644 /tmp/agentgate.service.new /etc/systemd/system/agentgate.service
  else
    echo "  would install /etc/systemd/system/agentgate.service (仓库克隆后可生成)"
  fi
  run systemctl daemon-reload
run systemctl enable agentgate
  # restart, not enable --now: the unit may already be running with the old port or node path,
  # and enable --now leaves a running unit alone. The first re-run deployed 8081 into the unit
  # while the old process kept 8080, so the new configuration never took effect.
  run systemctl restart agentgate
fi

if [ "$APPLY" = "1" ]; then
  # Wait for the socket before asking. systemd returns from "enable --now" as soon as the process
  # exists, and the first deploy failed here: a healthy service was reported down, which also
  # skipped the Caddy step below.
  for i in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null; then break; fi
    [ "$i" = "30" ] && echo "  等了 30 秒,http://127.0.0.1:$PORT/health 还是没有应答"
    sleep 1
  done
  if ! "$NODE_BIN" "$DIR/scripts/smoke.mjs" http://127.0.0.1:$PORT --expect-min 1000; then
    echo
    echo "== smoke 没通过,先看这三个原因 =="
    echo "  1. 采集没跑成功 -> 服务读的是样本索引（records 会停在 300 左右）"
    echo "  2. node 路径不对 -> systemctl status agentgate / journalctl -u agentgate -n 40"
    echo "  3. 端口被占 -> ss -ltnp | grep $PORT"
    echo "--- journalctl -u agentgate -n 40 ---"
    journalctl -u agentgate -n 40 --no-pager 2>/dev/null || true
    exit 1
  fi
else
  run "$NODE_BIN" "$DIR/scripts/smoke.mjs" http://127.0.0.1:$PORT --expect-min 1000
fi

if [ "$WITH_CADDY" = "1" ]; then
  echo
  echo "== Caddy（--with-caddy）=="
  if ! command -v caddy >/dev/null 2>&1; then
    echo "  Caddy 还没装。按你的发行版执行,然后重跑: sudo bash $0 --apply --with-caddy"
    if [ "$PKG" = "apt" ]; then
      echo "    sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https"
      echo "    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg"
      echo "    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list"
      echo "    sudo apt-get update && sudo apt-get install -y caddy"
    elif [ "$PKG" = "dnf" ] || [ "$PKG" = "yum" ]; then
      echo "    sudo $PKG install -y dnf-command(copr) && sudo $PKG copr enable -y @caddy/caddy && sudo $PKG install -y caddy"
    else
      echo "    https://caddyserver.com/docs/install"
    fi
  else
    DEST=/etc/caddy/Caddyfile
    MARK_BEGIN="# agentgate-managed-begin"
    MARK_END="# agentgate-managed-end"
    BLOCK=/tmp/agentgate-caddy-block
    if [ -f "$DIR/deploy/Caddyfile" ]; then
    { echo "$MARK_BEGIN"; sed "s#127.0.0.1:8080#127.0.0.1:$PORT#g" "$DIR/deploy/Caddyfile"; echo "$MARK_END"; } > "$BLOCK"
    # 这台机器的主域上已经跑着别的站点。绝不覆盖:只备份后追加我们标了记的一段。
    run bash "$DIR/scripts/caddy-append.sh" "$DEST" "$BLOCK"
    if [ "$APPLY" = "1" ]; then
      if caddy validate --config "$DEST" >/dev/null 2>&1; then
        systemctl reload caddy 2>/dev/null || systemctl restart caddy
        echo "  已追加并 reload。证书在 app./api. 的 DNS 生效后自动签发,看 journalctl -u caddy -n 50。"
        echo "  主域上的原有站点没有被动过;改动前的备份是 $DEST.bak.*"
      else
        LATEST="$(ls -t "$DEST".bak.* 2>/dev/null | head -1 || true)"
        if [ -n "$LATEST" ]; then cp "$LATEST" "$DEST"; echo "  配置校验没过,已回滚到 $LATEST"; else rm -f "$DEST"; echo "  配置校验没过,已删除刚写入的文件"; fi
        caddy validate --config "$DEST" 2>&1 | tail -5 || true
        exit 1
      fi
    else
      echo "  会先备份现有 $DEST,再只追加 agentgate 的段落(不覆盖主域上的站点),然后 validate + reload"
    fi
    else
      echo "  仓库还没克隆,拿不到 $DIR/deploy/Caddyfile;--apply 时它会在,那时才追加"
    fi
  fi
fi
echo

if [ "$MODE" = "node" ] && [ "$WITH_CADDY" != "1" ]; then
  echo "== 这一步没做,要你(或我)接着做 =="
  echo "  对外 HTTPS 还没配。服务只在回环上跑,公网访问不了。"
  if [ "$PKG" = "apt" ]; then echo "    sudo apt-get install -y caddy"; elif [ "$PKG" = "dnf" ] || [ "$PKG" = "yum" ]; then echo "    sudo $PKG install -y caddy"; else echo "    # 装 Caddy:按你的发行版(apt-get / dnf / yum)"; fi
  echo "    sudo cp $DIR/deploy/Caddyfile /etc/caddy/Caddyfile"
  echo "    sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy"
  echo "  前提:前置一节那五条 DNS 都已生效,且大陆机器已完成 ICP 备案(见 docs/operations/plan-b-no-icp.md)。"
  echo
fi
echo "== 我接下来会看的 =="
echo "  - data/index.json 的 generatedAt 是不是当天"
echo "  - records 是不是几千条，而不是样本的 300 条"
echo "  - data/history/ 有没有生成第一份快照与 diff"
echo
if [ "$APPLY" != "1" ]; then
  echo "这是预演。确认无误后加 --apply 执行。"
fi
