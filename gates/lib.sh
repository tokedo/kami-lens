# Shared by the gate runners (gates/g*.sh); sourced, not executed.
#
# skippable NAME CMD... — run one gate part that can report "not runnable
# here" (exit 2: an input it needs is not on this machine, e.g. the
# hand-captured G2.b transcription, which is not part of the public tree).
# Exit 0 → go on; exit 2 → print one SKIP line, remember the part, go on;
# any other exit code stops the runner with that code (under `set -e`).
# A skip is not a pass: summary names every skipped part.

SKIPPED_PARTS=""  # a plain string: bash 3.2 (macOS) has no empty-array-safe `set -u`

skippable() {
  local name=$1
  shift
  local rc=0
  "$@" || rc=$?
  if [[ $rc -eq 2 ]]; then
    printf 'SKIP %s — not runnable here (exit 2); the runner goes on to the next part\n' "$name"
    SKIPPED_PARTS="${SKIPPED_PARTS:+$SKIPPED_PARTS }$name"
    return 0
  fi
  return "$rc"
}

# summary GATE — the runner's last line
summary() {
  if [[ -n $SKIPPED_PARTS ]]; then
    printf '\n%s PASS — every part that ran exited 0; skipped: %s (check docs/measurements/ for dated records)\n' \
      "$1" "$SKIPPED_PARTS"
  else
    printf '\n%s PASS — all parts exited 0 (check docs/measurements/ for dated records)\n' "$1"
  fi
}
