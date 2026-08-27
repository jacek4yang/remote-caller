#!/usr/bin/env bash
set -Eeuo pipefail

WORKSPACE=${WORKSPACE:-/mnt/c/Users/20220/Documents/remote-caller}
TARGET_DIR=${CARGO_TARGET_DIR:-$WORKSPACE/target-wsl}
BIN=${REMOTE_CALLER_BIN:-$TARGET_DIR/x86_64-unknown-linux-gnu/release/remote-caller}
LOG_DIR=/tmp/remote-caller-e2e
DOMAIN=call.example.com
TURN_SECRET=integration-turn-secret-at-least-32-characters
PASSWORD=integration-test-password

rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

cleanup() {
  set +e
  journalctl -u remote-caller --no-pager >"$LOG_DIR/journal.log" 2>/dev/null
  systemctl disable --now remote-caller >/dev/null 2>&1
  systemctl stop nginx >/dev/null 2>&1
  rm -f /etc/systemd/system/remote-caller.service
  rm -rf /etc/remote-caller /opt/remote-caller /var/www/remote-caller
  rm -f /etc/nginx/conf.d/remote-caller.conf
  rm -rf "/etc/letsencrypt/live/$DOMAIN"
  sed -i "/# remote-caller-e2e$/d" /etc/hosts
  systemctl daemon-reload >/dev/null 2>&1
}
trap cleanup EXIT

assert_contains() {
  local file=$1 expected=$2
  grep -Fq "$expected" "$file" || {
    echo "ASSERTION FAILED: $file does not contain: $expected" >&2
    return 1
  }
}

test -x "$BIN"
command -v nginx >/dev/null
command -v turnutils_uclient >/dev/null
command -v wrk >/dev/null
systemctl disable --now coturn >/dev/null 2>&1 || true
id remote-caller >/dev/null 2>&1 || useradd --system --home /opt/remote-caller --shell /usr/sbin/nologin remote-caller

install -d -o remote-caller -g remote-caller /opt/remote-caller/bin
printf '127.0.0.1 %s # remote-caller-e2e\n' "$DOMAIN" >> /etc/hosts
install -m 0755 "$BIN" /opt/remote-caller/bin/remote-caller
install -d -o root -g remote-caller -m 0750 /etc/remote-caller/tls
install -d "/etc/letsencrypt/live/$DOMAIN"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=Remote Caller E2E Root CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -addext 'subjectKeyIdentifier=hash' \
  -keyout "$LOG_DIR/root-ca.key" -out "$LOG_DIR/root-ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj "/CN=$DOMAIN" \
  -keyout "/etc/letsencrypt/live/$DOMAIN/privkey.pem" -out "$LOG_DIR/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' "$DOMAIN" >"$LOG_DIR/server.ext"
openssl x509 -req -days 2 -in "$LOG_DIR/server.csr" -CA "$LOG_DIR/root-ca.pem" \
  -CAkey "$LOG_DIR/root-ca.key" -CAcreateserial -extfile "$LOG_DIR/server.ext" \
  -out "$LOG_DIR/server.pem" >/dev/null 2>&1
cat "$LOG_DIR/server.pem" "$LOG_DIR/root-ca.pem" >"/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
install -o root -g remote-caller -m 0640 "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" /etc/remote-caller/tls/fullchain.pem
install -o root -g remote-caller -m 0640 "/etc/letsencrypt/live/$DOMAIN/privkey.pem" /etc/remote-caller/tls/privkey.pem

HASH=$(printf '%s' "$PASSWORD" | /opt/remote-caller/bin/remote-caller hash-password)
cat > /etc/remote-caller/remote-caller.env <<EOF
BIND_ADDR=127.0.0.1:8080
SERVE_STATIC=false
JWT_SECRET=integration-jwt-secret-at-least-32-characters
ADMIN_USERNAME=admin
ADMIN_DISPLAY_NAME=IntegrationAdmin
ADMIN_PASSWORD_HASH='$HASH'
USERS_JSON='[]'
SESSION_TTL_SECS=604800
AUTH_MAX_CONCURRENT_HASHES=2
MAX_WS_CONNECTIONS=16
MAX_WS_PER_USER=3
MAX_ROOMS=8
WS_TICKET_TTL_SECS=30
MAX_PENDING_WS_TICKETS=32
EMBEDDED_TURN=true
TURN_SECRET=$TURN_SECRET
TURN_REALM=$DOMAIN
TURN_PUBLIC_IP=127.0.0.1
TURN_BIND_IP=0.0.0.0
TURN_PORT=3478
TURN_TLS_PORT=5349
TURN_RELAY_MIN_PORT=49160
TURN_RELAY_MAX_PORT=49175
TURN_TLS_CERT=/etc/remote-caller/tls/fullchain.pem
TURN_TLS_KEY=/etc/remote-caller/tls/privkey.pem
STUN_URL=stun:$DOMAIN:3478
RUST_LOG=remote_caller=info,tower_http=info
EOF
chmod 0600 /etc/remote-caller/remote-caller.env

cp "$WORKSPACE/deploy/systemd/remote-caller.service" /etc/systemd/system/remote-caller.service
install -d /var/www/remote-caller/web
cp -a "$WORKSPACE/web/." /var/www/remote-caller/web/
rm -f /etc/nginx/sites-enabled/default
cp "$WORKSPACE/deploy/nginx/remote-caller.conf" /etc/nginx/conf.d/remote-caller.conf

nginx -t >"$LOG_DIR/nginx-test.log" 2>&1
systemctl daemon-reload
systemctl enable --now remote-caller
systemctl restart nginx

for _ in $(seq 1 50); do
  curl -fsS http://127.0.0.1:8080/health/ready >"$LOG_DIR/health.json" 2>/dev/null && break
  sleep .1
done
assert_contains "$LOG_DIR/health.json" 'ready'
systemctl is-active --quiet remote-caller
systemctl is-active --quiet nginx
! systemctl is-active --quiet coturn

# Exact process, ELF and bind-address checks.
file /opt/remote-caller/bin/remote-caller >"$LOG_DIR/file.txt"
assert_contains "$LOG_DIR/file.txt" 'ELF 64-bit'
test "$(pgrep -xc remote-caller)" -eq 1
ss -lntup >"$LOG_DIR/sockets.txt"
assert_contains "$LOG_DIR/sockets.txt" '127.0.0.1:8080'
assert_contains "$LOG_DIR/sockets.txt" '0.0.0.0:3478'
assert_contains "$LOG_DIR/sockets.txt" '0.0.0.0:5349'

# Nginx static delivery, TLS, redirect, headers and API authentication.
curl -sk --resolve "$DOMAIN:443:127.0.0.1" -D "$LOG_DIR/index.headers" "https://$DOMAIN/" -o "$LOG_DIR/index.html"
assert_contains "$LOG_DIR/index.html" 'Remote Caller'
assert_contains "$LOG_DIR/index.headers" 'content-security-policy:'
test "$(curl -s -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:80:127.0.0.1" "http://$DOMAIN/")" = 301

LOGIN_JSON=$(curl -sk --resolve "$DOMAIN:443:127.0.0.1" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PASSWORD\"}" \
  "https://$DOMAIN/api/login")
printf '%s' "$LOGIN_JSON" >"$LOG_DIR/login.json"
TOKEN=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' <<<"$LOGIN_JSON")
test -n "$TOKEN"
test "$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"wrong-password"}' \
  "https://$DOMAIN/api/login")" = 401

curl -sk --resolve "$DOMAIN:443:127.0.0.1" -H "Authorization: Bearer $TOKEN" \
  "https://$DOMAIN/api/config" >"$LOG_DIR/ice.json"
python3 - "$LOG_DIR/ice.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
urls = [url for server in data["iceServers"] for url in server["urls"]]
assert any(url.startswith("stun:") for url in urls), urls
assert any(url.startswith("turn:") and "transport=udp" in url for url in urls), urls
assert any(url.startswith("turns:") for url in urls), urls
PY
TURN_USERNAME=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); s=next(x for x in d["iceServers"] if x.get("username")); print(s["username"])' "$LOG_DIR/ice.json")
TURN_PASSWORD=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); s=next(x for x in d["iceServers"] if x.get("credential")); print(s["credential"])' "$LOG_DIR/ice.json")
test -n "$TURN_USERNAME"
test -n "$TURN_PASSWORD"

# WebSocket upgrade through the exact Nginx location using a single-use ticket.
TICKET_JSON=$(curl -sk --resolve "$DOMAIN:443:127.0.0.1" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"room":"test-room"}' "https://$DOMAIN/api/ws-ticket")
TICKET=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["ticket"])' <<<"$TICKET_JSON")
test -n "$TICKET"
set +e
curl -sk --http1.1 --max-time 2 --resolve "$DOMAIN:443:127.0.0.1" \
  -D "$LOG_DIR/websocket.headers" -o /dev/null \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "https://$DOMAIN/ws?ticket=$TICKET"
set -e
assert_contains "$LOG_DIR/websocket.headers" '101 Switching Protocols'

# TLS identity for the embedded TURN listener.
openssl s_client -connect 127.0.0.1:5349 -servername "$DOMAIN" \
  -CAfile "$LOG_DIR/root-ca.pem" </dev/null \
  >"$LOG_DIR/turn-tls.txt" 2>&1
assert_contains "$LOG_DIR/turn-tls.txt" 'Verification: OK'

# Send a real STUN Binding request over TLS and validate the complete response
# header. This avoids turnutils_uclient's OpenSSL multi-connection failure while
# still testing the encrypted TURN application-protocol path independently.
python3 - "$DOMAIN" "$LOG_DIR/root-ca.pem" >"$LOG_DIR/turn-tls-protocol.log" <<'PY'
import os
import socket
import ssl
import struct
import sys

domain, ca_file = sys.argv[1:]
cookie = 0x2112A442
transaction_id = os.urandom(12)
request = struct.pack("!HHI12s", 0x0001, 0, cookie, transaction_id)
context = ssl.create_default_context(cafile=ca_file)

with socket.create_connection(("127.0.0.1", 5349), timeout=5) as raw:
    with context.wrap_socket(raw, server_hostname=domain) as tls:
        tls.sendall(request)
        header = b""
        while len(header) < 20:
            chunk = tls.recv(20 - len(header))
            if not chunk:
                raise RuntimeError("TURN TLS listener closed before the STUN header")
            header += chunk
        message_type, length, response_cookie, response_id = struct.unpack("!HHI12s", header)
        body = b""
        while len(body) < length:
            chunk = tls.recv(length - len(body))
            if not chunk:
                raise RuntimeError("TURN TLS listener closed before the STUN body")
            body += chunk

assert message_type == 0x0101, hex(message_type)
assert response_cookie == cookie, hex(response_cookie)
assert response_id == transaction_id
assert length == len(body)
print("STUN Binding over TLS: OK")
PY
assert_contains "$LOG_DIR/turn-tls-protocol.log" 'STUN Binding over TLS: OK'

# TURN protocol tests use Coturn only as an external client tool. The -y mode
# creates two TURN clients that relay to each other, avoiding a forbidden
# loopback peer target on the server itself.
timeout 20 turnutils_uclient -L 127.0.0.1 -u "$TURN_USERNAME" -w "$TURN_PASSWORD" -y -c -n 20 \
  127.0.0.1 >"$LOG_DIR/turn-udp.log" 2>&1
assert_contains "$LOG_DIR/turn-udp.log" 'Total lost packets 0'
timeout 20 turnutils_uclient -t -L 127.0.0.1 -u "$TURN_USERNAME" -w "$TURN_PASSWORD" -y -c -n 20 \
  127.0.0.1 >"$LOG_DIR/turn-tcp.log" 2>&1
assert_contains "$LOG_DIR/turn-tcp.log" 'Total lost packets 0'

# Short concurrent baseline through the real HTTPS/Nginx/Rust path. The raw
# result is retained because WSL numbers are host-specific, not a production SLA.
wrk -t2 -c64 -d10s --latency "https://$DOMAIN/health/ready" \
  >"$LOG_DIR/wrk-health.log" 2>&1
assert_contains "$LOG_DIR/wrk-health.log" 'Requests/sec:'
awk '/Requests\/sec:/ { if ($2 + 0 <= 0) exit 1; found=1 } END { if (!found) exit 1 }' \
  "$LOG_DIR/wrk-health.log"

# systemd recovery and post-restart readiness.
OLD_PID=$(systemctl show -p MainPID --value remote-caller)
systemctl restart remote-caller
for _ in $(seq 1 50); do
  curl -fsS http://127.0.0.1:8080/health/ready >/dev/null 2>&1 && break
  sleep .1
done
NEW_PID=$(systemctl show -p MainPID --value remote-caller)
test "$OLD_PID" != "$NEW_PID"
systemctl is-active --quiet remote-caller

journalctl -u remote-caller --no-pager >"$LOG_DIR/journal.log"
! grep -Eiq 'panic|segmentation fault|address already in use' "$LOG_DIR/journal.log"

echo 'PASS: Linux ELF, systemd, Nginx, HTTPS, API, WebSocket, TURN UDP/TCP/TLS, load baseline and restart recovery'
