#!/data/data/com.termux/files/usr/bin/bash
# Deterministic local self-test for security-analysis-router.
set -euo pipefail

skill_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
skill_file="$skill_root/SKILL.md"
vendor_root="$HOME/.pi/agent/vendor/reverse-skill"
expected_commit='6aa1362d60ff1c53722b37a28215a39d14bf1ace'
fixture="$(mktemp -d "$HOME/.cache/security-analysis-router-test-XXXXXX")"
trap 'find "$fixture" -mindepth 1 -delete 2>/dev/null || true; rmdir "$fixture" 2>/dev/null || true' EXIT

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }

[[ -r "$skill_file" ]] || fail 'SKILL.md is not readable'
grep -q '^name: security-analysis-router$' "$skill_file" || fail 'skill name/frontmatter'
grep -q '^description:' "$skill_file" || fail 'skill description/frontmatter'
grep -q 'LOCAL_SOURCE_REVIEW' "$skill_file" || fail 'route table'
[[ "$("$skill_root/scripts/route.sh" --kind source --auth granted --network offline)" == 'LOCAL_SOURCE_REVIEW' ]] || fail 'source route'
[[ "$("$skill_root/scripts/route.sh" --kind binary --auth granted --network offline)" == 'LOCAL_BINARY_TRIAGE' ]] || fail 'binary route'
[[ "$("$skill_root/scripts/route.sh" --kind malware --auth granted --network authorized_target_only)" == 'DOCUMENTATION_ONLY' ]] || fail 'malware offline gate'
[[ "$("$skill_root/scripts/route.sh" --kind lab --auth missing --network missing)" == 'DOCUMENTATION_ONLY' ]] || fail 'scope gate'
pass 'Pi skill structure, frontmatter, and deterministic routes'

[[ -d "$vendor_root/.git" ]] || fail 'vendor snapshot missing'
[[ "$(git -C "$vendor_root" rev-parse HEAD)" == "$expected_commit" ]] || fail 'vendor commit changed'
[[ "$(git -C "$vendor_root" remote get-url --push origin)" == 'DISABLED' ]] || fail 'vendor push URL enabled'
pass 'pinned reference snapshot'

bash -n "$skill_root/scripts/termux-tool-index.sh"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$skill_root/scripts/route.sh" "$skill_root/scripts/termux-tool-index.sh" "$0"
fi
inventory_output="$("$skill_root/scripts/termux-tool-index.sh")"
inventory_path="${inventory_output#Tool inventory written: }"
[[ -s "$inventory_path" ]] || fail 'inventory output missing'
grep -q '^| file | yes |' "$inventory_path" || fail 'file not detected'
grep -q '^| JADX | yes |' "$inventory_path" || fail 'jadx not detected'
grep -q '^| radare2 | yes |' "$inventory_path" || fail 'radare2 not detected'
pass "detection-only inventory ($inventory_path)"

cat > "$fixture/Benign.java" <<'JAVA'
public class Benign {
    public static String greeting() { return "hello"; }
}
JAVA
javac -d "$fixture" "$fixture/Benign.java"
jar --create --file "$fixture/benign.jar" -C "$fixture" Benign.class
jadx --no-res -d "$fixture/jadx-out" "$fixture/benign.jar" >/dev/null 2>&1
grep -R -F 'return "hello"' "$fixture/jadx-out" >/dev/null || fail 'jadx output mismatch'
pass 'JADX local decompilation'

rabin2 -Ij "$(command -v bash)" | jq -e '.info.arch != null' >/dev/null || fail 'rabin2 JSON'
r2 -2q -c 'ij' "$(command -v bash)" | jq -e '.core.file != null' >/dev/null || fail 'radare2 JSON'
pass 'radare2/rabin2 local binary triage'

printf 'hello benign fixture\n' > "$fixture/benign.txt"
cat > "$fixture/benign.yar" <<'YARA'
rule BenignFixture {
  strings:
    $a = "hello benign fixture"
  condition:
    $a
}
YARA
yara "$fixture/benign.yar" "$fixture/benign.txt" | grep -q '^BenignFixture ' || fail 'YARA match'
binwalk "$fixture/benign.txt" >/dev/null || fail 'binwalk local scan'
pass 'YARA and binwalk local analysis'

apktool --help >/dev/null 2>&1 || fail 'apktool startup'
aapt2 version >/dev/null 2>&1 || fail 'aapt2 startup'
pass 'apktool/aapt2 startup'

printf 'ALL_TESTS_PASSED\n'
