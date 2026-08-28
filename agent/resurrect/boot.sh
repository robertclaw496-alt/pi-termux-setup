#!/data/data/com.termux/files/usr/bin/sh
# pi-resurrect boot script (for ~/.termux/boot/, executed by the Termux:Boot APK).
#
# Status on this device: INERT. Termux:Boot is not installed, so Android has no
# BOOT_COMPLETED path into Termux and this script is never executed. It is
# installed and kept correct so that boot recovery starts working as soon as the
# APK is present, with no further changes.
#
# Deliberate behavior: it does NOT unconditionally start Pi after a reboot. It
# runs the same decision logic as every other trigger, so a session the user
# stopped normally before rebooting stays stopped.

export PATH="/data/data/com.termux/files/usr/bin:$PATH"
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PI_RESURRECT_NO_HOOK=1

# A wake lock here is justified: without it Android may freeze this short check
# before it finishes. It is released immediately afterwards.
if command -v termux-wake-lock >/dev/null 2>&1; then
  timeout 10s termux-wake-lock >/dev/null 2>&1 || true
fi

"$HOME/.local/bin/pi-resurrect" check --trigger boot >>"$HOME/.pi/agent/runtime/resurrection-boot.log" 2>&1
STATUS=$?

if command -v termux-wake-unlock >/dev/null 2>&1; then
  timeout 10s termux-wake-unlock >/dev/null 2>&1 || true
fi

exit $STATUS
