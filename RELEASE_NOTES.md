# Remote Caller v1.0.0

The first production release of the private, two-person Remote Caller service.

Highlights:

- Rust authentication and signaling with an explicit account allowlist, Argon2id hashes, strict JWT validation, and bounded login work.
- Short-lived, one-use WebSocket tickets; JWTs are not placed in WebSocket URLs.
- Race-safe two-account rooms, bounded WebSocket/ticket/room state, signaling size/rate limits, and graceful reconnect replacement.
- Serialized WebRTC negotiation, queued/stale ICE handling, glare recovery, jittered signaling reconnects, and bounded ICE restarts.
- Embedded Rust STUN/TURN with per-account credentials derived from a rotatable secret.
- A documented, minimal patch to turn-server 4.1.4 that bounds transport/session/queue state and allocation lifetime.
- Hardened Nginx/systemd templates, health/readiness endpoints, deployment documentation, pinned CI actions, and a checksummed Linux x86-64-v2 package.

Security boundary: TURN credentials are stable until TURN_SECRET is rotated and the service restarts. Relay IDs are virtual and forward only between allocations on the same embedded TURN instance; they are not public firewall ports and this is not a general-purpose TURN relay.

The automated suite covers authentication, JWTs, WebSocket tickets, room races/reconnect, resource limits, signaling validation, TURN authentication/session bounds, JavaScript/shell syntax, Nginx/systemd validation, release builds, and RustSec advisories.

Real iOS/Android foreground calls, public NAT compatibility, Wi-Fi/cellular handoff, codec/device behavior, and multi-hour duration still require testing on the deployment's actual devices and networks. Browser/PWA lock-screen or indefinite background calling is not supported.

Assets:

- remote-caller-v1.0.0-linux-x86_64.tar.gz
- SHA256SUMS
