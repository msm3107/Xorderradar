#!/bin/sh
# Radar Zamówień — smoke test after an install or an update (PR-07B,
# docs/DEPLOY.md). Run as root on the host:
#
#   sh /opt/radar-zamowien/deploy/smoke.sh [https://radar.example.invalid]
#
# Without an argument the origin is PUBLIC_BASE_URL from the env file.
# Checks: `health` and `status` as the radar user, the radar-serve unit, the
# public front page (200 with exactly one HSTS header) and the HTTP -> HTTPS
# redirect. Prints one PASS/FAIL line per check and nothing else: no command
# output (it may carry configuration) and no value from the env file except
# the origin, which is public. Exit 0 only when every check passed.
#
# Note: `status` exits 1 on any problem — before the first ingest
# (source_never_run) or the first backup (backup_missing) too — and, with
# HEARTBEAT_URL set, a passing `status` sends one heartbeat ping.

set -eu

# Overridable for tests only; the defaults are the paths of docs/DEPLOY.md.
RADAR_DIR=${RADAR_DIR:-/opt/radar-zamowien}
RADAR_ENV_FILE=${RADAR_ENV_FILE:-/etc/radar/radar.env}
RADAR_USER=${RADAR_USER:-radar}
NODE=${NODE:-/usr/bin/node}

failed=0

pass() { printf 'PASS %s\n' "$1"; }
fail() {
	printf 'FAIL %s\n' "$1"
	failed=1
}

# check NAME COMMAND...: PASS when the command exits 0; its output is dropped.
check() {
	name=$1
	shift
	if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi
}

if [ "$(id -u)" -ne 0 ]; then
	printf 'FAIL must run as root (it runs the commands as %s)\n' "$RADAR_USER"
	exit 1
fi

origin=${1:-}
if [ -z "$origin" ] && [ -r "$RADAR_ENV_FILE" ]; then
	origin=$(sed -n 's/^PUBLIC_BASE_URL=//p' "$RADAR_ENV_FILE" | tail -n 1)
fi
# An origin as PUBLIC_BASE_URL has it: https://host[:port], nothing else.
case $origin in
https:// | https://*/* | *[!A-Za-z0-9.:/-]*) bad_origin=1 ;;
https://*) bad_origin=0 ;;
*) bad_origin=1 ;;
esac
if [ "$bad_origin" -ne 0 ]; then
	printf 'FAIL origin must be https://<host> without a path\n'
	exit 1
fi
host=${origin#https://}

app() {
	(cd "$RADAR_DIR" && runuser -u "$RADAR_USER" -- "$NODE" --env-file="$RADAR_ENV_FILE" dist/main.js "$@")
}

check "health (as $RADAR_USER)" app health
check "status (as $RADAR_USER)" app status
check "radar-serve is active" systemctl is-active --quiet radar-serve

# The front page: status 200 and exactly one Strict-Transport-Security header
# (set by the application; a second one would come from the proxy).
headers=$(curl -sS --max-time 10 --proto '=https' -o /dev/null -D - "$origin/" 2>/dev/null || true)
code=$(printf '%s\n' "$headers" | sed -n '1s/^HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p')
hsts=$(printf '%s\n' "$headers" | grep -ci '^strict-transport-security:' || true)
if [ "$code" = 200 ]; then pass "front page 200"; else fail "front page 200"; fi
if [ "$hsts" = 1 ]; then pass "one HSTS header"; else fail "one HSTS header"; fi

# Plain HTTP is redirected to HTTPS by Caddy.
redirect=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code} %{redirect_url}' "http://$host/" 2>/dev/null || true)
case $redirect in
"301 https://$host/"* | "308 https://$host/"*) pass "http redirects to https" ;;
*) fail "http redirects to https" ;;
esac

if [ "$failed" -ne 0 ]; then
	printf 'Smoke test FAILED\n'
	exit 1
fi
printf 'Smoke test passed\n'
