#!/bin/sh
# usage: scripts/build.sh [silk|celt|all] [2|3|all] [release|checked|both]
#   -> target/mini{silk,celt}-wasm{2,3}.wasm (release) and target/mini{silk,celt}-wasm{2,3}-checked.wasm
#      (release code with debug assertions and overflow checks, for tests)
set -e
cd "$(dirname "$0")/.."
c=${1:-all}
v=${2:-all}
p=${3:-release}
build() { # $1 = crate, $2 = variant, $3 = target features, $4 = target dir, $5 = profile
  cargo build --profile "$5" -p "$1-wasm" --target wasm32-unknown-unknown \
    --config "target.wasm32-unknown-unknown.rustflags=[\"-Ctarget-feature=$3\"]" --target-dir "$4"
  suffix=; [ "$5" = checked ] && suffix=-checked
  cp "$4/wasm32-unknown-unknown/$5/$1_wasm.wasm" "target/$1-wasm$2$suffix.wasm"
  ls -l "target/$1-wasm$2$suffix.wasm"
}
mkdir -p target
for crate in minisilk minicelt; do
  [ "$c" = all ] || [ "$c" = "${crate#mini}" ] || continue
  [ -d "$crate" ] || continue
  for profile in release checked; do
    if [ "$p" = "$profile" ] || [ "$p" = both ]; then
      if [ "$v" = 2 ] || [ "$v" = all ]; then build "$crate" 2 +simd128 target "$profile"; fi
      if [ "$v" = 3 ] || [ "$v" = all ]; then build "$crate" 3 +simd128,+relaxed-simd target/v3 "$profile"; fi
    fi
  done
done
