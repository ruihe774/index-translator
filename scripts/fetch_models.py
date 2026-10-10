# /// script
# requires-python = ">=3.10"
# dependencies = ["huggingface_hub>=0.34"]
# ///
"""Download the pinned Index-Translate GGUF into ./models and verify its checksum.

Usage: uv run scripts/fetch_models.py [--quant Q6_K] [--dest models]
"""

import argparse
import hashlib
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

REPO = "IndexTeam/Index-Translate-9B-GGUF"
REVISION = "645939fbab839a656f1bc39975a872bc8ad749f8"
STEM = "Index-Translate-9B"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 24):
            h.update(chunk)
    return h.hexdigest()


def expected_sum(sums: Path, filename: str) -> str | None:
    for line in sums.read_text().splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[-1].lstrip("*").split("/")[-1] == filename:
            return parts[0].lower()
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quant", default="Q6_K")
    ap.add_argument("--dest", default=str(Path(__file__).resolve().parent.parent / "models"))
    args = ap.parse_args()

    dest = Path(args.dest)
    filename = f"{STEM}.{args.quant}.gguf"
    sums = Path(hf_hub_download(REPO, "SHA256SUMS.txt", revision=REVISION, local_dir=dest))
    model = Path(hf_hub_download(REPO, filename, revision=REVISION, local_dir=dest))

    want = expected_sum(sums, filename)
    if want is None:
        print(f"error: {filename} is not listed in SHA256SUMS.txt", file=sys.stderr)
        return 1
    got = sha256(model)
    if got != want:
        print(f"error: checksum mismatch for {model}\n  want {want}\n  got  {got}", file=sys.stderr)
        return 1
    print(f"ok {model} sha256={got}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
