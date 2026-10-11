# /// script
# requires-python = ">=3.10"
# dependencies = ["huggingface_hub>=0.34"]
# ///
"""Download the pinned models into ./models and verify their checksums: the two Index-Translate GGUF
models, the IndexTTS-2.5 GGUF for reading aloud, and its example voices into ./voices.

Usage: uv run scripts/fetch_models.py [--model index-translate-9b ...] [--quant Q6_K] [--dest models]
                                      [--voices voices]

Model ids and file names must match src/models.ts; the speech paths must match src/config.ts.
"""

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

# id -> (repo, pinned revision, file stem)
MODELS = {
    "index-translate-9b": ("IndexTeam/Index-Translate-9B-GGUF", "645939fbab839a656f1bc39975a872bc8ad749f8", "Index-Translate-9B"),
    "index-nailong-9b": ("IndexTeam/Index-Nailong-9B-GGUF", "b77c686a6063b7fd89ac781a4f349baa8d9c940a", "Index-Nailong-9B"),
}

# IndexTTS-2.5 as converted for audio.cpp (Q8_0, about 3.5 GB). The repository has no checksum
# file, so the sum is pinned here.
SPEECH = "index-tts-2.5"
SPEECH_REPO = "audio-cpp/audio.cpp-gguf"
SPEECH_REVISION = "1b5981b2b89a1af578ebba5c8cf34226810e1f55"
SPEECH_FILE = "IndexTTS2.5-GGUF/index-tts2_5-q8_0.gguf"
SPEECH_SHA256 = "5e827b2072042e4a1b21ccf24a5cb4f71cb1011403067a0a9b039311d8b38628"

# IndexTTS has no built-in voices: a voice is a short reference recording that it imitates. These
# are the speaker prompts of the official demo.
VOICES_REPO = "IndexTeam/IndexTTS-2-Demo"
VOICES_REVISION = "b01840e8e4fd9753743a6d0466cd73ae1d634a68"
VOICES = {
    "voice_01.wav": "e33e6ee0107a1dd58e1d66dd90c13df3d55a8683047cc3d7ea206dad84ed3fc8",
    "voice_02.wav": "8fe2dd1dbd54ef85a073fbc4c8fc0198f8d4523cc3320a600de0e347a3d8b491",
    "voice_03.wav": "50e8b632efd794418919e2d33c8c2aab9189a57f4d21ef55020413be9f2b292a",
    "voice_04.wav": "2a3d2536245f45fd5e1eef046dd768ae7b72a0dba3ec3f370f145862fe64b3b2",
    "voice_05.wav": "eefb7f4a29a8b36f08d5cc1014ea947dbe9f7bef348f07c40263058e604a98eb",
    "voice_06.wav": "2d85800fe261d106c3274fa792cbb952458c4b0b2e1b908340a8cd0d63c73a30",
    "voice_07.wav": "bcb10f84e63c3fdbfe99ac4184ca403b46a6d20b50540732713d48c4c95375ce",
    "voice_08.wav": "2e2c5f4859999b1ada95ee801d50c3c72879147269a4ed99e385fd917dae5c6f",
    "voice_09.wav": "8702467b9b3c83a16bead578e131c4388b3ef82aeff861bd336e622a9ae8a511",
    "voice_11.wav": "82730e38498413d4371a76e841cd91fa2f74843b79ad3b606d45ad8a7b7a736c",
    "voice_12.wav": "d67bd4f51773677d5902409813b9bb4c1d59b8243c74fc104553b80b49edd22b",
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


def verify(path: Path, want: str) -> bool:
    got = sha256(path)
    if got != want:
        print(f"error: checksum mismatch for {path}\n  want {want}\n  got  {got}", file=sys.stderr)
        return False
    print(f"ok {path} sha256={got}")
    return True


def fetch(model_id: str, quant: str, dest: Path) -> bool:
    repo, revision, stem = MODELS[model_id]
    filename = f"{stem}.{quant}.gguf"
    sums = Path(hf_hub_download(repo, "SHA256SUMS.txt", revision=revision, local_dir=dest))
    model = Path(hf_hub_download(repo, filename, revision=revision, local_dir=dest))

    want = expected_sum(sums, filename)
    if want is None:
        print(f"error: {filename} is not listed in SHA256SUMS.txt", file=sys.stderr)
        return False
    return verify(model, want)


def fetch_speech(dest: Path, voices: Path) -> bool:
    model = Path(hf_hub_download(SPEECH_REPO, SPEECH_FILE, revision=SPEECH_REVISION, local_dir=dest))
    ok = verify(model, SPEECH_SHA256)

    voices.mkdir(parents=True, exist_ok=True)
    for name, want in VOICES.items():
        target = voices / name
        # Voices already there are kept: the folder is the user's, and may hold their own recordings.
        if not target.exists():
            cached = hf_hub_download(
                VOICES_REPO, f"examples/{name}", revision=VOICES_REVISION, repo_type="space"
            )
            shutil.copyfile(cached, target)
        ok = verify(target, want) and ok
    return ok


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", action="append", choices=sorted([*MODELS, SPEECH]), help="repeatable; default: all")
    ap.add_argument("--quant", default="Q6_K", help="quantization of the translation models")
    ap.add_argument("--dest", default=str(root / "models"))
    ap.add_argument("--voices", default=str(root / "voices"), help="where the example voices go")
    args = ap.parse_args()

    dest = Path(args.dest)
    ids = args.model or [*MODELS, SPEECH]
    results = [
        fetch_speech(dest, Path(args.voices)) if model_id == SPEECH else fetch(model_id, args.quant, dest)
        for model_id in ids
    ]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
