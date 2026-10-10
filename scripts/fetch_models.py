# /// script
# requires-python = ">=3.10"
# dependencies = ["huggingface_hub>=0.34"]
# ///
"""Download the pinned Index-Translate GGUF models into ./models and verify their checksums.

Usage: uv run scripts/fetch_models.py [--model index-translate-9b ...] [--quant Q6_K] [--dest models]

Model ids and file names must match src/models.ts.
"""

import argparse
import hashlib
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

# id -> (repo, pinned revision, file stem)
MODELS = {
    "index-translate-9b": ("IndexTeam/Index-Translate-9B-GGUF", "645939fbab839a656f1bc39975a872bc8ad749f8", "Index-Translate-9B"),
    "index-nailong-9b": ("IndexTeam/Index-Nailong-9B-GGUF", "b77c686a6063b7fd89ac781a4f349baa8d9c940a", "Index-Nailong-9B"),
}


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


def fetch(model_id: str, quant: str, dest: Path) -> bool:
    repo, revision, stem = MODELS[model_id]
    filename = f"{stem}.{quant}.gguf"
    sums = Path(hf_hub_download(repo, "SHA256SUMS.txt", revision=revision, local_dir=dest))
    model = Path(hf_hub_download(repo, filename, revision=revision, local_dir=dest))

    want = expected_sum(sums, filename)
    if want is None:
        print(f"error: {filename} is not listed in SHA256SUMS.txt", file=sys.stderr)
        return False
    got = sha256(model)
    if got != want:
        print(f"error: checksum mismatch for {model}\n  want {want}\n  got  {got}", file=sys.stderr)
        return False
    print(f"ok {model} sha256={got}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", action="append", choices=sorted(MODELS), help="repeatable; default: all")
    ap.add_argument("--quant", default="Q6_K")
    ap.add_argument("--dest", default=str(Path(__file__).resolve().parent.parent / "models"))
    args = ap.parse_args()

    dest = Path(args.dest)
    ids = args.model or list(MODELS)
    results = [fetch(model_id, args.quant, dest) for model_id in ids]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
