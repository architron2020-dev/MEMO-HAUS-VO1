#!/usr/bin/env bash
# Generates a self-signed HTTPS certificate for the Vite dev server so the
# upload page is a "secure context" — required by browsers for
# navigator.mediaDevices.getUserMedia() (microphone access) on anything
# other than localhost, which includes the LAN IP phones reach via the QR
# code. Without this, recording a voice note fails with "permission
# denied" and the browser never even shows the allow/deny prompt.
#
# Re-run this if your LAN IP changes (e.g. switching networks) — add it to
# the -addext line below alongside the existing IPs.
set -euo pipefail

cd "$(dirname "$0")/../apps/web"
mkdir -p .cert
cd .cert

LAN_IP="${1:-$(ipconfig 2>/dev/null | grep -A1 'IPv4' | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1)}"
echo "Generating dev certificate for localhost, 127.0.0.1, and ${LAN_IP:-<none detected>}..."

MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 825 \
  -subj "/CN=memo-haus-dev" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1${LAN_IP:+,IP:$LAN_IP}"

echo "Done — apps/web/.cert/cert.pem + key.pem written."
echo "Restart 'npm run dev' to pick it up. The site will show a"
echo "self-signed-certificate warning on first visit — that's expected,"
echo "click through it (e.g. 'Advanced > Proceed') once per device."
