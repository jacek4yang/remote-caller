# Local turn-server patch

This directory is `turn-server` 4.1.4 from upstream commit
`b9a6b8f2e5c4c120b4780e021b1fe0b10b71583a` (tag `v4.1.4`). It is vendored
because the public TURN listener otherwise has unbounded session/transport
state and accepts an excessive lifetime in an initial Allocate request.

The local patch is intentionally limited to:

- a configurable hard session cap;
- a shared cap for live UDP, TCP, and TLS transport state, including a bound
  on the UDP source-tuple map;
- bounded per-transport relay queues (full queues drop media packets instead
  of growing memory without limit);
- a 30-second lifetime for unauthenticated challenge sessions;
- a one-hour maximum authenticated allocation lifetime;
- capacity-sized internal maps instead of the upstream 16,384-entry default.

Protocol parsing, authentication, relay routing, and cryptography are otherwise
unchanged. The application keeps `static_auth_secret` disabled
because 4.1.4 deliberately does not validate the timestamp convention used by
TURN REST usernames.
