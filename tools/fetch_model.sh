#!/usr/bin/env bash
# Downloads the pinned sat-3l-sm export (the only file the engine supports) and its tokenizer into
# ${SAT_MODEL_DIR:-models/sat-3l-sm} and checks both against their SHA-256.
#
#   model.onnx      segment-any-text/sat-3l-sm (MIT), 8-bit ONNX export by jiangzhuo9357, 241945842 bytes
#   tokenizer.json  FacebookAI/xlm-roberta-base's tokenizer, unmodified (only test/e2e.ts and tools/dump_windows.ts use it)
#
# HF_ENDPOINT names a mirror instead of https://huggingface.co. Usage: tools/fetch_model.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=jiangzhuo9357/sat-3l-sm-onnx
REVISION=7698b9e41fef7a1e24638b9aaff2108ce1020657
ENDPOINT=${HF_ENDPOINT:-https://huggingface.co}
DIR=${SAT_MODEL_DIR:-models/sat-3l-sm}
mkdir -p "$DIR"
fetch() {
  local name=$1 sha=$2 out="$DIR/$1"
  if [[ -f "$out" ]] && echo "$sha  $out" | sha256sum -c --status; then
    echo "$out: present, checksum ok"
    return
  fi
  curl -fL --retry 3 -C - -o "$out.part" "${ENDPOINT%/}/$REPO/resolve/$REVISION/$name"
  echo "$sha  $out.part" | sha256sum -c --quiet
  mv "$out.part" "$out"
  echo "$out: downloaded, checksum ok"
}
fetch model.onnx 1132546a16fa1aa9da218602049c6e7aeba0ec5b76409131446f40ebda2be99f
fetch tokenizer.json a898ea75433890f6610f4e470b8ebeb0c21dce5c8dd61f892eb09eb5919d2e2c
