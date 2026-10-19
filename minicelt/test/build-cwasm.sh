#!/bin/sh
# usage: minicelt/test/build-cwasm.sh   (from anywhere; called by scripts/test.sh when outputs are missing)
# Builds the fork's C (libopus 1.6.1 + celt/wasm and silk/wasm SIMD kernels, OPUS_WASM_SRC, default
# /home/user/opus-v1.6.1-wasm-simd) with wasi-sdk (WASI_SDK_PATH, default /opt/wasi-sdk) together with
# minicelt/test/shim.c and analysis_stub.c (instead of src/analysis.c, mlp*.c) as wasm32-wasip1 reactors:
#   target/native/minicelt-cwasm2.wasm   -msimd128
#   target/native/minicelt-cwasm3.wasm   -msimd128 -mrelaxed-simd
# They export the shim_* functions plus malloc/free and _initialize. Flags and source lists follow
# minicelt/oracle/build.rs; -ffp-contract=off so that only explicit relaxed_madd intrinsics fuse.
# cwasm3 is the bit-exact reference for the WASM 3.0 minicelt build (same engine, same FMA behaviour).
set -e
cd "$(dirname "$0")/../.."
SRC=$(realpath "${OPUS_WASM_SRC:-/home/user/opus-v1.6.1-wasm-simd}")
SDK=${WASI_SDK_PATH:-/opt/wasi-sdk}
[ -f "$SRC/celt_sources.mk" ] || { echo "OPUS_WASM_SRC $SRC is not a libopus tree" >&2; exit 1; }
[ -x "$SDK/bin/clang" ] || { echo "wasi-sdk not found at $SDK (set WASI_SDK_PATH)" >&2; exit 1; }
out=$PWD/target/native
mkdir -p "$out"
# Source files of a make variable: the continuation lines after "VAR =" up to the first blank line.
mk() { awk -v v="$2" '$1==v && $2=="=" {on=1; next} on && NF==0 {exit} on {for(i=1;i<=NF;i++) if ($i ~ /\.c$/) print $i}' "$SRC/$1"; }
files=$( { mk opus_sources.mk OPUS_SOURCES; mk opus_sources.mk OPUS_SOURCES_FLOAT; mk celt_sources.mk CELT_SOURCES
  mk silk_sources.mk SILK_SOURCES; mk silk_sources.mk SILK_SOURCES_FLOAT; mk silk_sources.mk SILK_SOURCES_WASM_SIMD
  mk silk_sources.mk SILK_SOURCES_FLOAT_WASM_SIMD; mk celt_sources.mk CELT_SOURCES_WASM_SIMD; } |
  grep -v -e '^src/analysis\.c$' -e '^src/mlp\.c$' -e '^src/mlp_data\.c$' | sed "s|^|$SRC/|" )
exports=$(sed -n 's/^[A-Za-z_ *]*[ *]\(shim_[a-z_]*\)(.*/\1/p' minicelt/test/shim.c | sed 's/^/-Wl,--export=/' | tr '\n' ' ')
[ -n "$exports" ] || { echo "no shim_ functions found" >&2; exit 1; }
for v in 2 3; do
  extra=; [ $v = 3 ] && extra=-mrelaxed-simd
  "$SDK/bin/clang" --target=wasm32-wasip1 --sysroot="$SDK/share/wasi-sysroot" -mexec-model=reactor \
    -O2 -msimd128 $extra -ffp-contract=off -DHAVE_CONFIG_H -w \
    -Iminicelt/test/cwasm -I"$SRC" -I"$SRC/include" -I"$SRC/celt" -I"$SRC/silk" -I"$SRC/silk/float" -I"$SRC/src" \
    $files minicelt/test/shim.c minicelt/test/analysis_stub.c \
    -Wl,--export=malloc -Wl,--export=free $exports \
    -o "$out/minicelt-cwasm$v.wasm"
  ls -l "$out/minicelt-cwasm$v.wasm"
done
