#!/usr/bin/env bash
# Everything that must pass before a push. pipefail matters: without it, `cmd | grep`
# returns grep's status and a failure inside the pipe goes unnoticed, which is how a
# broken test suite got pushed once.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== yaml =="
if python3 -c "import yaml" 2>/dev/null; then
  python3 -c "import yaml, glob; [yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml') + ['action.yml', '.github/dependabot.yml', 'examples/github-actions/policy.yml']]; print('ok')"
else
  echo "pyyaml not available here; skipped (CI validates YAML in a step of its own)"
fi
echo "== tests =="
npm test --silent
echo "== acceptances =="
node scripts/acceptance.mjs > /dev/null && echo "M1 ok"
node scripts/acceptance-m2.mjs > /dev/null && echo "M2 ok"
node scripts/acceptance-m3.mjs > /dev/null && echo "M3 ok"
node scripts/acceptance-m4.mjs > /dev/null && echo "M4 ok"
node scripts/acceptance-m5.mjs > /dev/null && echo "M5 ok"
echo "== supply chain =="
node scripts/check-zero-deps.mjs
node scripts/sbom.mjs --out "${TMPDIR:-/tmp}/agentgate-sbom.cdx.json" > /dev/null && echo "sbom ok"
echo "== deploy rehearsal (everything except systemd and Caddy) =="
# pipefail is set above, so a failure inside the pipe still stops the script
node scripts/rehearse-deploy.mjs | tail -1
echo "== regression and scale =="
node packages/guard/scripts/regression.mjs > /dev/null && echo "regression ok"
node scripts/bench.mjs 20000 100 | tail -1
node scripts/measure-verify.mjs | head -3
echo "ALL CHECKS PASSED"
