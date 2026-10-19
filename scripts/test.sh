#!/bin/sh
# usage: scripts/test.sh [2|3|all] [cargo test args...]
#   2   = WASM 2.0 variant (+simd128), the .cargo/config.toml default, target/
#   3   = WASM 3.0 variant (+simd128,+relaxed-simd), target/v3/
#   all = both (default)
set -e
cd "$(dirname "$0")/.."
v=${1:-all}; [ $# -gt 0 ] && shift
if [ "$v" = 2 ] || [ "$v" = all ]; then
  echo "== WASM 2.0 (simd128)"
  cargo test "$@"
fi
if [ "$v" = 3 ] || [ "$v" = all ]; then
  echo "== WASM 3.0 (simd128 + relaxed-simd)"
  cargo test --config 'target.wasm32-wasip1.rustflags=["-Ctarget-feature=+simd128,+relaxed-simd"]' \
    --target-dir target/v3 "$@"
fi
