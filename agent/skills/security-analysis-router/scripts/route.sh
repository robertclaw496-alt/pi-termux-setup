#!/data/data/com.termux/files/usr/bin/bash
# Deterministic, side-effect-free route selector for security-analysis-router.
set -euo pipefail

kind=''
auth='missing'
network='missing'

usage() {
  cat <<'EOF'
Usage: route.sh --kind <source|binary|apk|javascript|malware|forensics|lab> \
                --auth <granted|missing|denied> \
                --network <offline|lab_only|authorized_target_only|missing>

Prints exactly one Route ID. It never accesses a target or the network.
EOF
}

while (($#)); do
  case "$1" in
    --kind)
      (($# >= 2)) || { usage >&2; exit 2; }
      kind="$2"; shift 2 ;;
    --auth)
      (($# >= 2)) || { usage >&2; exit 2; }
      auth="$2"; shift 2 ;;
    --network)
      (($# >= 2)) || { usage >&2; exit 2; }
      network="$2"; shift 2 ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2 ;;
  esac
done

case "$auth" in granted|missing|denied) ;; *) printf 'Invalid auth value\n' >&2; exit 2 ;; esac
case "$network" in offline|lab_only|authorized_target_only|missing) ;; *) printf 'Invalid network value\n' >&2; exit 2 ;; esac

if [[ "$auth" != 'granted' || "$network" == 'missing' ]]; then
  printf 'DOCUMENTATION_ONLY\n'
  exit 0
fi

case "$kind" in
  source) route='LOCAL_SOURCE_REVIEW' ;;
  binary) route='LOCAL_BINARY_TRIAGE' ;;
  apk) route='LOCAL_APK_STATIC' ;;
  javascript) route='LOCAL_JS_ANALYSIS' ;;
  malware)
    [[ "$network" == 'offline' ]] || { printf 'DOCUMENTATION_ONLY\n'; exit 0; }
    route='OFFLINE_MALWARE_ANALYSIS'
    ;;
  forensics) route='OFFLINE_FORENSICS' ;;
  lab)
    [[ "$network" == 'lab_only' ]] || { printf 'DOCUMENTATION_ONLY\n'; exit 0; }
    route='AUTHORIZED_LAB_ANALYSIS'
    ;;
  '') printf 'DOCUMENTATION_ONLY\n'; exit 0 ;;
  *) printf 'Invalid kind value\n' >&2; exit 2 ;;
esac

printf '%s\n' "$route"
