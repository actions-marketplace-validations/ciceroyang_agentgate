#!/usr/bin/env bash
#
# 一条命令回答"现在到底绿不绿"。
#
# 存在的理由:我两次把 red 说成了 green。一次是用 `bash scripts/verify.sh | tail` 读结果,
# 管道把退出码换成了 tail 的;一次是查"最新一次运行"时没按工作流过滤,看到的是 pages 的成功,
# 而 test 工作流当时是 failure。这个脚本不给我看错的机会:它跑门禁并打印真实退出码,
# 然后按 commit 逐个工作流列出来,最后给一个总判定。
set -uo pipefail
cd "$(dirname "$0")/.."

REQUIRED="test pages action-verify"
VERDICT=0

echo "== 本机门禁 =="
bash scripts/verify.sh
GATE=$?
echo "  门禁退出码: $GATE"
[ "$GATE" != "0" ] && VERDICT=1

SHA=$(git rev-parse HEAD)
SHORT=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
REPO=$(git remote get-url origin 2>/dev/null | node -e 'let s="";process.stdin.on("data",function(d){s+=d}).on("end",function(){const m=/github\.com[:/]([^/]+\/[^/]+?)(\.git)?\s*$/.exec(s.trim());process.stdout.write(m?m[1]:"")})')

echo
echo "== 远端 =="
git fetch -q origin "$BRANCH" 2>/dev/null || true
REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "?")
if [ "$SHA" = "$REMOTE" ]; then
  echo "  已推送（本地 == origin）"
else
  echo "  未推送（本地 $SHORT != origin 的 ${REMOTE:0:7}）—— CI 还不会跑这个 commit"
  VERDICT=1
fi

if ! command -v gh >/dev/null 2>&1 || [ -z "$REPO" ]; then
  echo "  没有 gh 或拿不到远端仓库名,查不了 CI"
  echo
  echo "判定: 未知（只验了本机门禁,CI 没查）"
  exit 2
fi

echo
echo "== CI（$REPO @ $SHORT）=="
gh run list -R "$REPO" --limit 40 --json workflowName,status,conclusion,headSha > /tmp/ag-status-runs.json 2>/dev/null || echo "[]" > /tmp/ag-status-runs.json
node -e '
const req = process.argv[1].split(" ");
const sha = process.argv[2];
const runs = JSON.parse(require("fs").readFileSync("/tmp/ag-status-runs.json", "utf8"));
const byName = new Map();
for (const r of runs) if (r.headSha === sha) byName.set(r.workflowName, r);
let bad = 0;
for (const name of req) {
  const r = byName.get(name);
  if (!r) { console.log("  " + name.padEnd(14) + " 没有这次 commit 的运行"); bad = 1; continue }
  console.log("  " + name.padEnd(14) + " " + r.status + "/" + (r.conclusion || ""));
  if (r.status !== "completed" || r.conclusion !== "success") bad = 1;
}
process.exit(bad);
' "$REQUIRED" "$SHA"
CI=$?
[ "$CI" != "0" ] && VERDICT=1

echo
[ "$VERDICT" = "0" ] && echo "判定: 绿（门禁 + CI 三个工作流）" || echo "判定: 红（上面标出的就是原因）"
exit "$VERDICT"
