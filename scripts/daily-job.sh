#!/bin/sh
#
# The daily chain. One failure here is unrecoverable in a way the others are not: a day with no
# capture is gone, and no amount of later work brings it back. So this script is written so that
# a failed refresh does not cost the day -- the index already on disk is still a capture, and
# skipping it is not -- and every step reports instead of aborting, because the step that used to
# sit last (the review) exits non-zero by design whenever a person is needed.
#
# It is scheduled more than once a day for the same reason. The snapshot step appends a line only
# when the record actually changed, so the extra runs cost a refresh and nothing else.
#
#   /etc/cron.d/agentgate:  17 4,8,12,16,20 * * * agentgate /opt/agentgate/scripts/daily-job.sh
#
set -u
cd "$(dirname "$0")/.." || exit 1
NODE="${NODE:-/usr/bin/node}"
STATIC_DIR="${AGENTGATE_STATIC_DIR:-/var/www/zhiliang}"
FAILED=0

log() { echo "[daily-job $(date -u +%FT%TZ)] $*"; }
step() {
  if "$@" > /dev/null 2>&1; then
    return 0
  fi
  log "FAILED: $*"
  FAILED=1
  return 1
}

log "start"

# A failed refresh is not a failed day: the capture records the index that is already there.
if $NODE bin/agentgate.mjs refresh --max 300 > /dev/null 2>&1; then
  log "refresh: ok"
else
  log "refresh: failed, capturing the index already on disk"
fi

step $NODE scripts/daily-snapshot.mjs
step $NODE scripts/build-site.mjs --index "$PWD/data/index.json" --out "$STATIC_DIR" --name evidence.html --pages "$PWD/site"

# The age of the last capture is part of verification, so this is where a stopped job becomes
# visible in the log; /health carries the same number for anything watching from outside.
step $NODE bin/agentgate.mjs history --max-age 26

# Last, and deliberately not part of the && chain: it exits 1 whenever a high or critical finding
# has not been read by a person, which is a request for attention, not a reason to skip the day.
step $NODE scripts/review-criticals.mjs

if [ "$FAILED" = "1" ]; then
  log "done with failures"
  exit 1
fi
log "done"
