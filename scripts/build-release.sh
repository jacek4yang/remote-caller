#!/usr/bin/env sh
set -eu

TARGET_DIR=${CARGO_TARGET_DIR:-target}

cargo test --locked --all-features
# This release is intentionally tied to the build server CPU for maximum x86_64 performance.
# Override RUSTFLAGS with target-cpu=x86-64-v3 when the artifact must run on multiple servers.
RUSTFLAGS="${RUSTFLAGS:--C target-cpu=native}" cargo build --locked --release --target x86_64-unknown-linux-gnu

rm -rf dist
mkdir -p dist/bin dist/web dist/deploy/nginx dist/deploy/systemd dist/docs dist/scripts
cp "$TARGET_DIR/x86_64-unknown-linux-gnu/release/remote-caller" dist/bin/
cp -R web/. dist/web/
cp deploy/nginx/remote-caller.conf dist/deploy/nginx/
cp deploy/nginx/bootstrap.conf dist/deploy/nginx/
cp deploy/systemd/remote-caller.service deploy/systemd/remote-caller.env.example dist/deploy/systemd/
cp docs/*.md dist/docs/
cp scripts/test-production-wsl.sh dist/scripts/
cp README.md LICENSE dist/

tar -C dist -czf remote-caller-linux-release.tar.gz .
sha256sum remote-caller-linux-release.tar.gz > remote-caller-linux-release.tar.gz.sha256
printf '%s\n' "Created remote-caller-linux-release.tar.gz"
