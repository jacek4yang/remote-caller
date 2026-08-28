#!/usr/bin/env sh
set -eu

TARGET_DIR=${CARGO_TARGET_DIR:-target}
VERSION=$(sed -n 's/^version = "\([^"]*\)"/\1/p' Cargo.toml | head -1)
TAG="v$VERSION"
ROOT="remote-caller-$TAG-linux-x86_64"
ARCHIVE="$ROOT.tar.gz"

cargo fmt --all -- --check
cargo fmt --manifest-path vendor/turn-server/Cargo.toml --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-features
RUSTFLAGS="${RUSTFLAGS:--C target-cpu=x86-64-v2}" \
  cargo build --release --locked --target x86_64-unknown-linux-gnu

rm -rf -- dist
mkdir -p "dist/$ROOT/bin" "dist/$ROOT/web" "dist/$ROOT/deploy/nginx" \
  "dist/$ROOT/deploy/systemd" "dist/$ROOT/docs" "dist/$ROOT/scripts"
install -m 0755 "$TARGET_DIR/x86_64-unknown-linux-gnu/release/remote-caller" \
  "dist/$ROOT/bin/remote-caller"
cp -R web/. "dist/$ROOT/web/"
cp deploy/nginx/*.conf "dist/$ROOT/deploy/nginx/"
cp deploy/systemd/remote-caller.service deploy/systemd/remote-caller.env.example \
  "dist/$ROOT/deploy/systemd/"
cp docs/*.md "dist/$ROOT/docs/"
install -m 0755 scripts/test-production-wsl.sh "dist/$ROOT/scripts/test-production-wsl.sh"
cp .env.example README.md CONTRIBUTING.md LICENSE "dist/$ROOT/"

tar -C dist -czf "$ARCHIVE" "$ROOT"
sha256sum "$ARCHIVE" > SHA256SUMS
tar -tzf "$ARCHIVE" | grep -q "^$ROOT/bin/remote-caller$"
test -s "$ARCHIVE"
printf '%s\n' "Created $ARCHIVE and SHA256SUMS"
