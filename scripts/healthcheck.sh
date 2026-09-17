#!/bin/sh
#
# Cron entry point. Secrets live in one mode-0600 file outside the repository and are sourced
# here, because cron.d cannot source anything itself. Without that file the check still runs and
# still exits non-zero; it just cannot mail, and it says so.
set -u
cd "$(dirname "$0")/.." || exit 1
NODE="${NODE:-/usr/bin/node}"
ENV_FILE="${AGENTGATE_ALERT_ENV:-/etc/agentgate/alert.env}"
if [ -r "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "[healthcheck] $ENV_FILE 不可读：只巡检，不发告警" >&2
fi
exec "$NODE" scripts/healthcheck.mjs "$@"
