#!/bin/sh
# Per-function differential tests against the C oracle (minicelt/oracle), run as
# wasm32-wasip1 binaries under Node's WASI.
# usage: minicelt/scripts/oracle-test.sh [2|3|all] [cargo test args...]
#   2   = WASM 2.0 variant (+simd128), target/
#   3   = WASM 3.0 variant (+simd128,+relaxed-simd), target/v3/
#   all = both (default)
# Env: WASI_SDK_PATH (default /opt/wasi-sdk), OPUS_WASM_SRC (fork branch v1.6.1-wasm-simd, default
#      third_party/opus-wasm-simd).
set -e
cd "$(dirname "$0")/../.."
v=${1:-all}; [ $# -gt 0 ] && shift
if [ "$v" = 2 ] || [ "$v" = all ]; then
  echo "== WASM 2.0 (simd128)"
  cargo test -p minicelt --target wasm32-wasip1 "$@"
fi
if [ "$v" = 3 ] || [ "$v" = all ]; then
  echo "== WASM 3.0 (simd128 + relaxed-simd)"
  cargo test -p minicelt --target wasm32-wasip1 \
    --config 'target.wasm32-wasip1.rustflags=["-Ctarget-feature=+simd128,+relaxed-simd"]' \
    --target-dir target/v3 "$@"
fi
