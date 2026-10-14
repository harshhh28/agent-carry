#!/bin/sh
# Does `claude --resume` accept a session imported by carry into a folder it never ran in?
#
#   sh scripts/verify-resume.sh <session-id-prefix>     (ids: node src/cli.js list --all)
#
# Exports the session, imports it into a throwaway folder, resumes it with one
# short prompt, then deletes the throwaway folder and its copy of the session.
# The original session is only read. Costs one small API call.
set -eu

ID=${1:?usage: verify-resume.sh <session-id-prefix>}
HERE=$(cd "$(dirname "$0")/.." && pwd -P)
CARRY="node $HERE/src/cli.js"
CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}

TRY=$(mktemp -d "${TMPDIR:-/tmp}/carry-try.XXXXXX")
TRY=$(cd "$TRY" && pwd -P)
FOLDER="$CLAUDE_DIR/projects/$(printf '%s' "$TRY" | sed 's/[^A-Za-z0-9]/-/g')"
cleanup() { rm -rf "$TRY" "$FOLDER"; echo "cleaned up $TRY and its session copy"; }
trap cleanup EXIT

echo "1/3 export"
$CARRY export "$ID" -o "$TRY/s.carry.gz"
FULL=$($CARRY inspect "$TRY/s.carry.gz" | sed -n 's/.*"sessionId": "\(.*\)".*/\1/p')

echo "2/3 import into $TRY"
cd "$TRY"
$CARRY import "$TRY/s.carry.gz" >/dev/null

echo "3/3 resume $FULL from a folder it never ran in"
claude -p --resume "$FULL" "In one sentence: what was the very first thing the user asked in this conversation? Also say which directory we are in now." </dev/null
echo
echo "PASS if the answer above matches the session's first request and names $TRY."
