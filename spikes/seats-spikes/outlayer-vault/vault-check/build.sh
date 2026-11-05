#!/bin/sh
set -e
cargo build --target wasm32-wasip2 --release
mkdir -p out
cp target/wasm32-wasip2/release/vault_check.wasm out/
