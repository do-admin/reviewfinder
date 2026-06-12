#!/usr/bin/env bash
#
# Ralph-style loop for Astro conversion repos: one Claude invocation per iteration,
# fresh context each time. Run from repo root or pass destination as second argument.
#
# Usage:
#   ./conversion-kit/ralph-convert.sh 20
#   ./conversion-kit/ralph-convert.sh 20 /path/to/migrated-astro-repo
#
# Requires in the working directory (or --dest): PROMPT.md, prd.md
# Completion: Claude prints <promise>COMPLETE</promise>

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

if [[ -z "${1:-}" ]]; then
  echo -e "${RED}Error: Missing max_iterations${NC}"
  echo "Usage: $0 <max_iterations> [dest_dir]"
  exit 1
fi

MAX_ITERATIONS="$1"
DEST="${2:-.}"

cd "$DEST"

if [[ ! -f "PROMPT.md" ]]; then
  echo -e "${RED}Error: PROMPT.md not found in ${DEST}${NC}"
  exit 1
fi
if [[ ! -f "prd.md" ]]; then
  echo -e "${RED}Error: prd.md not found in ${DEST}${NC}"
  exit 1
fi

if [[ ! -f "activity.md" ]]; then
  echo -e "${YELLOW}Warning: activity.md missing; create one or run generate-ralph-conversion.mjs${NC}"
fi

mkdir -p screenshots

echo -e "${BLUE}Ralph conversion loop${NC} in $(pwd)"
echo -e "Max iterations: ${GREEN}${MAX_ITERATIONS}${NC}"
echo -e "Completion signal: ${GREEN}<promise>COMPLETE</promise>${NC}"
echo ""

tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT
trap 'echo ""; echo "Interrupted."; kill -9 %1 2>/dev/null; exit 130' INT

for ((i = 1; i <= MAX_ITERATIONS; i++)); do
  echo -e "${BLUE}--- Iteration $i of $MAX_ITERATIONS ---${NC}"
  # Single Claude process per iteration (new session = new invocation)
  claude -p "$(cat PROMPT.md)" --dangerously-skip-permissions --print 2>&1 | tee "$tmpfile" || true
  result="$(cat "$tmpfile")"
  if [[ "$result" == *"<promise>COMPLETE</promise>"* ]]; then
    echo -e "${GREEN}ALL TASKS COMPLETE${NC} after $i iteration(s)"
    exit 0
  fi
  sleep 2
done

echo -e "${RED}Max iterations reached without completion.${NC}"
exit 1
