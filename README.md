# Remote Caller

Remote Caller is a small, self-hosted WebRTC audio/video calling service for a fixed allowlist of trusted users. A production instance runs Nginx and one Rust process: Nginx serves the browser application and terminates HTTPS, while Rust provides authentication, WebSocket signaling, room management, STUN, and TURN.

Version 1.0.0 is intentionally designed for a private two-person deployment. It is not a public registration service, conference platform, SFU, or general-purpose TURN server.

## Architecture

```text
Browser A  <------------- WebRTC media ------------->  Browser B
    |                         |                             |
    | HTTPS / WSS             +-- embedded TURN fallback --+
    v
  Nginx  ---- HTTP / WS ---->  127.0.0.1:8080 Rust service
```

Media is peer-to-peer whenever ICE can find a direct path. Both browsers use the embedded Rust TURN service when a restrictive network prevents direct connectivity. No database, Redis, Coturn, Docker, Kubernetes, Node.js backend, or external identity service is required.

## Features

- Explicit server-side account allowlist; no registration endpoint.
- Argon2id password hashes and bounded password-verification concurrency.
- HS256 JWTs with required issuer, audience, issued-at, and expiry claims.
- Short-lived, single-use WebSocket tickets, so JWTs never appear in WebSocket URLs.
- Two distinct accounts per room, with atomic same-account reconnect replacement.
- Hard limits for rooms, tickets, WebSockets, signaling rate, message size, and TURN sessions.
- Serialized SDP/ICE processing, queued candidates, Perfect Negotiation glare handling, and stale-candidate filtering.
- WebSocket health detection and bounded reconnect/ICE-restart recovery.
- Embedded Rust STUN/TURN over UDP, TCP, and optional TLS.
- Liveness, readiness, and lightweight Prometheus-text metrics endpoints.
- Hardened Nginx and systemd examples.
- Tag-only, reproducible GitHub Release workflow with SHA-256 checksums.

## Security model

The source repository is public; a deployed service remains private because only accounts in `AUTH_USERS_JSON` can authenticate. Passwords are never stored in plaintext. Unknown usernames still perform an Argon2 verification, and the global Argon2 semaphore prevents an unbounded blocking-work queue.

The browser keeps its JWT in page memory. It exchanges the JWT for a random ticket that expires after 30 seconds and is consumed exactly once during WebSocket upgrade. Nginx disables access logging for `/ws` even though its query string contains only that ticket.

TURN credentials are not login passwords. At startup, the service derives one high-entropy credential per configured account from `TURN_SECRET` and installs only those credentials in the embedded TURN server. They remain valid until `TURN_SECRET` is rotated and the process is restarted. This is deliberate: `turn-server` 4.1.4 validates TURN REST HMACs but does not enforce the timestamp embedded in REST usernames, so Remote Caller does not claim a false credential TTL.

The exact vendored dependency is minimally patched to cap unauthenticated and authenticated session state, shorten unauthenticated challenges, and cap allocation lifetime at one hour. See [`vendor/turn-server/PATCHES.md`](vendor/turn-server/PATCHES.md).

Keep these values outside Git:

- `JWT_SECRET` and `TURN_SECRET`;
- Argon2id password hashes used by a real deployment;
- TLS private keys;
- SSH and deployment credentials.

If a browser or credential may be compromised, change the affected password hash, rotate both application secrets, and restart the service.

## Requirements

For a source build:

- Linux x86_64;
- Rust 1.85 or later (edition 2024 support);
- a C toolchain, CMake, and `pkg-config` for AWS-LC;
- Node.js only for the optional JavaScript syntax check.

For the published Linux artifact, Rust and build tools are not required. Production additionally needs Nginx, systemd, a DNS name, and a browser-trusted TLS certificate.

## Build and local development

Generate two development hashes without putting plaintext passwords in a file:

```bash
read -rsp 'Caller one password: ' PASSWORD_ONE; echo
HASH_ONE=$(printf '%s' "$PASSWORD_ONE" | cargo run --quiet -- hash-password)
unset PASSWORD_ONE
read -rsp 'Caller two password: ' PASSWORD_TWO; echo
HASH_TWO=$(printf '%s' "$PASSWORD_TWO" | cargo run --quiet -- hash-password)
unset PASSWORD_TWO
```

Copy [`.env.example`](.env.example), replace every placeholder, and load it using a mechanism appropriate to your shell. The application does not parse `.env` files itself. For local browser testing, set `EMBEDDED_TURN=false`, `SERVE_STATIC=true`, and keep `BIND_ADDR=127.0.0.1:8080`.

Run the normal checks and start the service:

```bash
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-features
cargo build --release --locked
cargo run --locked
```

Open `http://localhost:8080`. Browsers treat localhost as a secure context, but real phones and cross-network tests require trusted HTTPS.

## Account configuration

`AUTH_USERS_JSON` is required and must contain 1–8 unique accounts. A typical two-account value is:

```text
AUTH_USERS_JSON='[{"username":"caller-one","displayName":"Caller One","passwordHash":"$argon2id$REPLACE_WITH_FIRST_HASH","role":"user"},{"username":"caller-two","displayName":"Caller Two","passwordHash":"$argon2id$REPLACE_WITH_SECOND_HASH","role":"user"}]'
```

Generate each full `$argon2id$...` value with `remote-caller hash-password`. Usernames accept ASCII letters, digits, `.`, `_`, and `-`; passwords must be 10–256 characters. Use independent passwords for the two accounts.

Generate independent application secrets:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

Each secret must contain at least 32 bytes and must not be reused for the other purpose.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `BIND_ADDR` | `127.0.0.1:8080` | Internal HTTP/WS listener; a non-loopback value is rejected |
| `JWT_SECRET` | required | High-entropy HS256 key, 32–1024 bytes |
| `AUTH_USERS_JSON` | required | JSON array of 1–8 configured accounts |
| `SESSION_TTL_SECS` | `604800` | JWT lifetime; accepted range 3600–2592000 seconds |
| `AUTH_MAX_CONCURRENT_HASHES` | `2` | Global Argon2 verification budget, maximum 8 |
| `MAX_WS_CONNECTIONS` | `16` | Global WebSocket limit, maximum 128 |
| `MAX_WS_PER_USER` | `3` | Per-account WebSocket limit, maximum 8 |
| `MAX_ROOMS` | `8` | Concurrent room limit, maximum 64 |
| `WS_TICKET_TTL_SECS` | `30` | One-use ticket lifetime, 10–300 seconds |
| `MAX_PENDING_WS_TICKETS` | `32` | Pending ticket limit, maximum 1024 |
| `EMBEDDED_TURN` | `true` on Linux | Start the in-process Rust STUN/TURN service |
| `TURN_SECRET` | required with TURN | Per-account TURN credential derivation secret |
| `TURN_PUBLIC_IP` | required with TURN | Public IP advertised in ICE candidates |
| `TURN_BIND_IP` | `0.0.0.0` | Local TURN listen address |
| `TURN_REALM` | `localhost` | TURN realm and default TURN host; use the call domain |
| `TURN_PORT` | `3478` | UDP and TCP STUN/TURN listener |
| `TURN_TLS_PORT` | `5349` | TURN-over-TLS TCP listener when cert/key are set |
| `TURN_TLS_CERT` / `TURN_TLS_KEY` | unset | PEM certificate chain and private key; configure together |
| `TURN_RELAY_MIN_PORT` / `TURN_RELAY_MAX_PORT` | `49160` / `49175` | Inclusive virtual allocation-ID range, at most 128 entries |
| `TURN_MAX_SESSIONS` | `64` | Hard session-table cap; 16–4096 with the default relay range |
| `TURN_URLS` | generated | Comma-separated TURN URLs returned to clients |
| `STUN_URL` | generated | STUN URL returned to clients |
| `STATIC_DIR` | `web` | Static browser application directory |
| `SERVE_STATIC` | `true` | Set `false` when Nginx serves `web/` |

The complete production template is [`deploy/systemd/remote-caller.env.example`](deploy/systemd/remote-caller.env.example).

## Production deployment

Use the tag artifact and verify it before extraction:

```bash
sha256sum -c SHA256SUMS
tar -xzf remote-caller-v1.0.0-linux-x86_64.tar.gz
cd remote-caller-v1.0.0-linux-x86_64
```

The supported layout is:

```text
/opt/remote-caller/bin/remote-caller
/var/www/remote-caller/web/
/etc/remote-caller/remote-caller.env
/etc/remote-caller/tls/{fullchain.pem,privkey.pem}
/etc/systemd/system/remote-caller.service
/etc/nginx/conf.d/remote-caller.conf
```

Create a dedicated user, install the files, set the environment file to mode `0600`, and keep the Rust HTTP listener on loopback. Obtain a certificate with the bootstrap Nginx configuration before installing the final TLS configuration. Exact commands, certificate renewal, upgrades, and rollback are in [`docs/DEPLOYMENT_ZH.md`](docs/DEPLOYMENT_ZH.md).

Validate before reload/restart:

```bash
sudo nginx -t
sudo systemd-analyze verify /etc/systemd/system/remote-caller.service
sudo systemctl daemon-reload
sudo systemctl enable --now remote-caller
curl -fsS http://127.0.0.1:8080/health/ready
curl -fsS https://call.example.com/health/ready
```

### Firewall

Open exactly the protocols enabled by the final configuration:

| Public port | Required | Use |
|---|---|---|
| TCP 80 | optional after certificate issuance | HTTP-to-HTTPS redirect and ACME HTTP-01 |
| TCP 443 | yes | HTTPS and WSS |
| UDP 3478 | yes | STUN/TURN; preferred media fallback |
| TCP 3478 | yes | TURN over TCP fallback |
| TCP 5349 | only with `TURN_TLS_CERT` and `TURN_TLS_KEY` | TURN over TLS |

Do **not** expose TCP 8080. In this exact embedded implementation, `49160–49175` are virtual allocation identifiers multiplexed over the configured TURN listeners, not kernel-bound UDP/TCP listeners, so opening that range is neither required nor useful.

This virtual-port design also means relay forwarding is between allocations on the same Remote Caller TURN instance. ICE must select a relay-to-relay pair; the service is not a general RFC 8656 relay to arbitrary Internet peers. That restriction sharply limits abuse but requires real-device and real-network compatibility testing for your browser pair.

## Nginx and systemd

[`deploy/nginx/remote-caller.conf`](deploy/nginx/remote-caller.conf) supplies TLS, HSTS, CSP, no-sniff/frame/referrer/permissions headers, request and connection limits, short API timeouts, 75-second WebSocket proxy timeouts refreshed by application heartbeats, and local-only metrics. Replace every `call.example.com` before use.

[`deploy/systemd/remote-caller.service`](deploy/systemd/remote-caller.service) runs as an unprivileged account with a read-only filesystem, private temporary/device namespaces, restricted address families, no capabilities, bounded file descriptors, and a 35-second stop timeout. The service marks itself unready and closes WebSockets on SIGTERM; dropping the embedded TURN future releases its listeners.

## Health, metrics, and troubleshooting

- `GET /health/live` returns 204 while the HTTP event loop responds.
- `GET /health/ready` returns 200 only while normal traffic is accepted and embedded TURN has bound successfully; otherwise it returns 503.
- `GET /metrics` exposes bounded in-process counters and gauges. The Nginx template restricts it to loopback.

Useful checks:

```bash
sudo systemctl status remote-caller
sudo journalctl -u remote-caller -n 200 --no-pager
sudo ss -lntup | grep -E ':(80|443|3478|5349|8080)\b'
curl -fsS https://call.example.com/health/ready
```

If direct calls work but TURN fallback does not, verify `TURN_PUBLIC_IP`, DNS, the 3478/5349 firewall rules, and that both clients received ICE configuration from the same instance. If login returns 429, the Argon2 budget or Nginx per-IP limit is protecting the service; wait and inspect logs for scanning. If a room stays full after a reconnect, confirm both clients are on v1.0.0 and inspect the active-connection/room metrics.

## Upgrading and rollback

Verify every new archive, retain the previous binary and web directory, install the new files atomically, then restart Rust and reload Nginx. If readiness fails, restore both previous components and restart. Detailed commands are in the deployment guide.

Tags are immutable release inputs. `.github/workflows/release.yml` publishes only on a SemVer tag, verifies that the tag matches `Cargo.toml`, tests the exact tagged source, builds for Linux x86-64-v2, and uploads:

```text
remote-caller-v1.0.0-linux-x86_64.tar.gz
SHA256SUMS
```

## Mobile and reliability limitations

Remote Caller targets foreground browser/PWA calls lasting hours under normal network conditions. The client retries signaling with jitter, performs negotiated ICE restarts after network failure, and rebuilds the peer connection after bounded retry failure.

This cannot guarantee FaceTime-like background or lock-screen operation. iOS and Android may suspend or terminate Safari, Chrome, or an installed PWA. System call UI, push wake-up, CallKit, and Android ConnectionService require native applications and are outside v1.0.0.

Multi-hour duration, public-NAT behavior, mobile codec performance, camera switching, and Wi-Fi/cellular handoff must be validated on the actual devices and networks. Unit tests and GitHub Actions cannot prove those properties.

## Additional documentation

- [Linux deployment](docs/DEPLOYMENT_ZH.md) (Chinese)
- [Architecture and security boundaries](docs/ARCHITECTURE_ZH.md) (Chinese)
- [Operations and incident response](docs/OPERATIONS_ZH.md) (Chinese)
- [v1.0.0 attacker-oriented security review](docs/SECURITY_REVIEW.md)
- [Performance and impaired-network test plan](docs/PERFORMANCE_TEST_ZH.md) (Chinese)
- [Codec and quality strategy](docs/ALGORITHM_ZH.md) (Chinese)
- [iOS/Android user guide](docs/USER_GUIDE_ZH.md) (Chinese)
- [Contributing and releases](CONTRIBUTING.md) (Chinese)

## License

MIT
