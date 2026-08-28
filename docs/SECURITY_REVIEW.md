# v1.0.0 security review

Scope: one public Linux VPS, two trusted configured accounts, Nginx in front of the Rust HTTP/WebSocket service, and the embedded Rust STUN/TURN implementation. This is an attacker-oriented design review, not a penetration-test certificate.

| Threat | v1.0.0 control | Residual risk / operator action |
|---|---|---|
| Public port scanning | Only 80/443, 3478 UDP/TCP, and optional 5349 TCP are documented; Rust HTTP rejects non-loopback binds | A public service remains discoverable; host/provider DDoS controls are outside the application |
| Login brute force / credential stuffing | Nginx per-IP rate limit, 4 KiB location body limit, global two-slot Argon2 semaphore, Argon2id hashes | Distributed low-rate attempts remain possible; use unique high-entropy account passwords |
| Username enumeration | Unknown users verify against a configured Argon2id hash and return the same 401 response as a wrong password | Network jitter and differing configured Argon2 parameters can still add statistical noise; generate both hashes with this binary |
| Malformed or oversized HTTP | Axum 8 KiB global body limit, strict JSON extraction, field length validation, Nginx body limits | Nginx and Rust must both remain deployed; do not expose TCP 8080 |
| JWT forgery / confusion | HS256 only; issuer, audience, subject, issued-at, expiry, signature, and maximum lifetime validated; current account data rechecked | A stolen JWT is usable until expiry or secret rotation; it is held only in page memory |
| JWT leakage through WebSocket URLs | Bearer JWT is exchanged for a random 30-second ticket | Reverse proxies should still avoid logging `/ws`; the supplied Nginx config disables that log |
| Ticket replay / exhaustion | Atomic remove-on-consume, expiry check, bounded map/semaphore, expired-entry cleanup | A stolen unused ticket can win a race during its short lifetime |
| WebSocket flood / exhaustion | Global, per-user, room, per-IP, frame/message, rate, and bounded-broadcast limits | A network-level flood can consume upstream bandwidth before application limits apply |
| Room race / stale reconnect | Two distinct usernames per room under a mutex; a fresh internal lease ID atomically replaces and cancels a same-account socket | One account can intentionally replace its own older connection |
| Malformed signaling / queue growth | Typed JSON envelope, allowlisted message types, 64 KiB limit, 30 messages/s, bounded broadcast and ICE queues; lag closes the socket | SDP/ICE semantic validation remains the browser WebRTC implementation's responsibility |
| XSS / clickjacking | No injected HTML, text-only peer names, same-origin static assets, CSP, no-sniff, DENY frame policy, restrictive referrer/permissions policies | A future frontend change must preserve CSP and avoid unsafe DOM sinks |
| TURN unauthenticated relay | Allocate/permission/channel operations require long-term credentials; only configured application usernames are installed | STUN Binding remains intentionally unauthenticated per protocol |
| TURN credential theft | Credential is derived from a separate server secret, never from the login password; rotation plus restart invalidates it | Credentials are stable until rotation because upstream 4.1.4 does not enforce REST username timestamps |
| TURN arbitrary-target abuse | Upstream relay routing permits only virtual allocations on the same instance; arbitrary peer IP relay is rejected | This is not a general-purpose TURN server and requires relay-to-relay browser compatibility testing |
| TURN allocation / memory / queue exhaustion | 16 virtual allocation IDs, 64 default sessions/transports, shared transport semaphore, bounded UDP tuple map/queues, 30-second challenges, one-hour allocation cap | A leaked valid credential can exhaust the small allocation pool; rotate the secret and use network controls |
| CPU / memory exhaustion | Bounded Argon2 work, bodies, tickets, rooms, sockets, messages, TURN state, and queues; systemd file-descriptor cap | Volumetric DDoS and kernel/socket backlog exhaustion require VPS/provider controls |
| Secret exposure | Placeholder-only examples, no query logging, path-only Rust tracing, CI secret pattern scan, no secret-bearing release inputs | Operators must keep the mode-0600 environment file, TLS keys, backups, and shell history private |
| Proxy bypass / plaintext app traffic | Config rejects non-loopback HTTP binds; Nginx terminates TLS and applies limits/security headers | A local hostile process can reach loopback; VPS host integrity remains trusted |
| Shutdown / partial service | SIGTERM marks readiness false, broadcasts WebSocket close, uses Axum graceful shutdown, drops TURN listeners, and systemd enforces a 35-second stop timeout | Calls using TURN are interrupted by restart; P2P media may continue until renegotiation is needed |

Before publishing a tag, the release gate requires formatting, clippy with warnings denied, all-feature tests, a locked release build, RustSec audit, JavaScript/shell syntax, Nginx syntax, systemd verification, repository secret scan, clean tree review, green main CI, and post-release asset/checksum inspection.

Not covered by automation: real public NAT combinations, multi-hour calls, mobile suspension, device codecs, Wi-Fi/cellular handoff, volumetric DDoS, host compromise, and social engineering.
