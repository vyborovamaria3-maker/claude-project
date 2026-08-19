#!/usr/bin/env bash
set -euo pipefail

: "${AUDIT_TARGET:?Set AUDIT_TARGET to an authorized http(s) URL}"
: "${AUDIT_AUTHORIZED:?Set AUDIT_AUTHORIZED=yes after confirming authorization}"

if [[ "${AUDIT_AUTHORIZED}" != "yes" ]]; then
  echo "Refusing to scan: AUDIT_AUTHORIZED must be exactly 'yes'." >&2
  exit 2
fi
if [[ ! "${AUDIT_TARGET}" =~ ^https?:// ]]; then
  echo "Refusing to scan: AUDIT_TARGET must be an http(s) URL." >&2
  exit 2
fi

AUDIT_PROFILE="${AUDIT_PROFILE:-production}"
AUDIT_OUT="${AUDIT_OUT:-security/audit/reports}"
AUDIT_COOKIE="${AUDIT_COOKIE:-}"
AUDIT_HEADER="${AUDIT_HEADER:-}"
mkdir -p "${AUDIT_OUT}"

extra_auth=()
if [[ -n "${AUDIT_COOKIE}" ]]; then
  extra_auth+=(--cookie "${AUDIT_COOKIE}")
fi
if [[ -n "${AUDIT_HEADER}" ]]; then
  extra_auth+=(--header "${AUDIT_HEADER}")
fi

echo "Target: ${AUDIT_TARGET}"
echo "Profile: ${AUDIT_PROFILE}"
echo "Reports: ${AUDIT_OUT}"

ran_any=0

if command -v webscan >/dev/null 2>&1; then
  if [[ "${AUDIT_PROFILE}" == "production" ]]; then
    webscan "${AUDIT_TARGET}" \
      --passive-only \
      --max-pages 50 \
      --max-requests 250 \
      --delay 0.5 \
      --format json \
      --output "${AUDIT_OUT}/webscan-passive.json" \
      "${extra_auth[@]}"
  else
    webscan "${AUDIT_TARGET}" \
      --max-pages 100 \
      --max-requests 1000 \
      --delay 0.2 \
      --threads 5 \
      --format json \
      --output "${AUDIT_OUT}/webscan-active.json" \
      "${extra_auth[@]}"
    webscan "${AUDIT_TARGET}" \
      --max-pages 100 \
      --max-requests 1000 \
      --delay 0.2 \
      --threads 5 \
      --format sarif \
      --output "${AUDIT_OUT}/webscan.sarif" \
      "${extra_auth[@]}"
  fi
  ran_any=1
elif [[ "${AUDIT_PROFILE}" == "production" ]]; then
  echo "Production DAST requires webscan; scanner is not installed." >&2
  exit 3
else
  echo "webscan not installed; skipping Web-vuln-scanner." >&2
fi

if [[ "${AUDIT_PROFILE}" != "production" ]]; then
  if command -v ghostmap >/dev/null 2>&1; then
    ghost_args=(scan "${AUDIT_TARGET}" --scope --depth 3 --max-pages 100 --delay 0.4 --concurrency 2 --checks all)
    if [[ -n "${AUDIT_COOKIE}" ]]; then
      ghost_args+=(--cookie "${AUDIT_COOKIE}")
    fi
    if [[ -n "${AUDIT_HEADER}" ]]; then
      ghost_args+=(--header "${AUDIT_HEADER}")
    fi
    ghostmap "${ghost_args[@]}" --format json --output "${AUDIT_OUT}/ghostmap.json"
    ghostmap "${ghost_args[@]}" --format sarif --output "${AUDIT_OUT}/ghostmap.sarif"
    ran_any=1
  else
    echo "ghostmap not installed; skipping ghostmap." >&2
  fi

  if command -v xhunter >/dev/null 2>&1; then
    if [[ -f "${AUDIT_OUT}/xhunter-urls.txt" && -f "${AUDIT_OUT}/xss-payloads.txt" ]]; then
      xhunter -l "${AUDIT_OUT}/xhunter-urls.txt" -w "${AUDIT_OUT}/xss-payloads.txt" -m xss -it param -a postfix -t 3 -v \
        | tee "${AUDIT_OUT}/xhunter-xss.txt"
      ran_any=1
    else
      echo "xhunter installed, but xhunter-urls.txt/xss-payloads.txt are absent; skipping targeted XSS run." >&2
    fi

    # XHunter SQLi is time-based and intentionally NOT automatic. Enable only on staging/lab.
    if [[ "${AUDIT_ENABLE_TIME_SQLI:-no}" == "yes" ]]; then
      if [[ -f "${AUDIT_OUT}/xhunter-urls.txt" && -f "${AUDIT_OUT}/sqli-payloads.txt" ]]; then
        xhunter -l "${AUDIT_OUT}/xhunter-urls.txt" -w "${AUDIT_OUT}/sqli-payloads.txt" -m sqli -it param -a postfix -t 1 -v \
          | tee "${AUDIT_OUT}/xhunter-sqli.txt"
        ran_any=1
      else
        echo "Time-SQLi requested, but targeted URL/payload files are absent." >&2
      fi
    fi
  else
    echo "xhunter not installed; skipping xhunter." >&2
  fi
else
  echo "Production profile: ghostmap/xhunter disabled; passive webscan only." >&2
fi

if [[ "${ran_any}" -ne 1 ]]; then
  echo "No DAST scanner actually ran; status is PENDING, not PASSED." >&2
  exit 3
fi

echo "DAST runner finished. Treat scanner findings as candidates until manually reproduced."
