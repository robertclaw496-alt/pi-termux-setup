#!/data/data/com.termux/files/usr/bin/bash
# Detection-only Termux tool inventory for the Pi security-analysis-router skill.
# No installation, network access, config edits, or target interaction.
set -euo pipefail

output_dir="/sdcard/Download"
if [[ ! -d "$output_dir" || ! -w "$output_dir" ]]; then
  output_dir="$HOME"
fi
output="$output_dir/pi-security-analysis-tools-$(date +%Y%m%d-%H%M%S).md"

version() {
  local command_name="$1"
  shift
  if command -v "$command_name" >/dev/null 2>&1; then
    "$command_name" "$@" 2>&1 | head -n 1 | tr '\n' ' ' || true
  else
    printf '%s' '—'
  fi
}

{
  printf '# Pi / Termux security-analysis tool inventory\n\n'
  printf -- "- Generated: \`%s\`\n" "$(date -Iseconds)"
  printf -- '- Mode: detection only; no installation, network access, or configuration change.\n\n'
  printf '| Tool | Available | Path | Version |\n|---|---|---|---|\n'
} > "$output"

while IFS='|' read -r name command_name version_args; do
  if path="$(command -v "$command_name" 2>/dev/null)"; then
    available='yes'
    # shellcheck disable=SC2086
    detected_version="$(version "$command_name" $version_args)"
  else
    available='no'
    path='—'
    detected_version='—'
  fi
  detected_version="${detected_version//|/\\|}"
  printf "| %s | %s | \`%s\` | %s |\n" "$name" "$available" "$path" "$detected_version" >> "$output"
done <<'TOOLS'
Python 3|python3|--version
Node.js|node|--version
npm|npm|--version
Git|git|--version
ADB|adb|version
Java|java|-version
Java compiler|javac|-version
aapt2|aapt2|version
file|file|--version
xxd|xxd|-v
jq|jq|--version
OpenSSL|openssl|version
ShellCheck|shellcheck|--version
unzip|unzip|-v
zipinfo|zipinfo|-h
strings|strings|--version
readelf|readelf|--version
objdump|objdump|--version
sha256sum|sha256sum|--version
JADX|jadx|--version
apktool|apktool|--version
Frida|frida|--version
Frida process tool|frida-ps|--version
radare2|r2|-v
rabin2|rabin2|-v
Ghidra headless|analyzeHeadless|--version
binwalk|binwalk|--version
YARA|yara|--version
Nmap|nmap|--version
TOOLS

printf '\n## Notes\n\n- Presence only means an executable is on PATH; it does not establish authorization or suitability.\n- Tool installation requires explicit user approval and a separate review.\n' >> "$output"
printf 'Tool inventory written: %s\n' "$output"
