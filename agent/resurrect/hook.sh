# pi-resurrect-hook
# Sourced from the interactive login shell. This is the Android-owned trigger
# that actually exists on this device: Android starts the Termux app, Termux
# starts the login shell, and that runs one short resurrection check.
#
# It must stay silent and cheap when nothing is wrong. It never blocks the shell:
# the check is backgrounded and its output is discarded, so a slow or broken
# check cannot make the terminal unusable.

# Skip inside a resurrected supervisor, non-interactive shells, and subshells of
# the check itself, so the trigger cannot recurse.
if [ -n "${PI_RESURRECT_NO_HOOK:-}" ] || [ -n "${PI_SAFE_SUPERVISOR:-}" ] || [ -n "${PI_RESURRECTED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
case "$-" in
  *i*) ;;
  *) return 0 2>/dev/null || exit 0 ;;
esac

if [ -x "$HOME/.local/bin/pi-resurrect" ]; then
  (
    PI_RESURRECT_NO_HOOK=1 \
    "$HOME/.local/bin/pi-resurrect" check --trigger shell-start --quiet >/dev/null 2>&1 &
  ) >/dev/null 2>&1
fi
