// Download the pinned models and verify their checksums: the two Index-Translate GGUF models with
// the chat model's image encoder (its mmproj GGUF), and
// the IndexTTS-2.5 GGUF for reading aloud and the BS-RoFormer GGUF that separates an uploaded voice
// sample from music and noise into MODELS_DIR (./models), the SaT sentence segmentation model (ONNX
// with its tokenizer) into MODELS_DIR/sat-3l-sm, the LaBSE sentence embedding model (ONNX with its
// vocabulary and pooling layer) into MODELS_DIR/labse, and the example voices into VOICES_DIR
// (./voices). About 18.5 GiB in all. In the AppImage this is its `fetch` subcommand.
// Usage: bun scripts/fetch_models.ts [--model index-translate-9b ...] [--models-dir DIR] [--voices-dir DIR]
//
//   --model  one of index-translate-9b, index-nailong-9b, index-tts-2.5 (the speech model and the
//            voices), bs-roformer (the voice separation model), sat-3l-sm (sentence segmentation),
//            labse (sentence alignment); repeatable; all of them when not given
//
// The directories are the server's settings (src/config.ts), given the same way: as environment
// variables or as flags. Files are downloaded with curl, so an interrupted download continues
// where it stopped when this is run again, and curl's proxy settings apply. HF_ENDPOINT names
// another host than https://huggingface.co (a mirror).
//
// Before anything is downloaded it prints the license notice of each model that is missing and waits
// for "yes" on standard input (a pipe works: `echo yes | ...`); anything else stops it. Models that
// are all there already ask nothing. The full notices are in THIRD_PARTY_NOTICES.md.

import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadConfig } from "../src/config";
import { MODELS } from "../src/models";
import { fileSha256 } from "./fetch_tools";

export interface Download {
  /** Path on the Hugging Face host, with the pinned revision in it. */
  url: string;
  sha256: string;
  dest: string;
  /** Kept as it is when it exists and differs: the file may be the user's own. */
  keep?: boolean;
}

const resolveUrl = (repo: string, revision: string, file: string) => `/${repo}/resolve/${revision}/${file}`;

/**
 * Model id to repository, pinned revision and checksum; the file names are those of src/models.ts.
 * `mmproj` is the checksum of the model's image encoder (Q8_0, 0.6 GB), from the same revision.
 */
const TRANSLATION: Record<string, { repo: string; revision: string; sha256: string; mmproj?: string }> = {
  "index-translate-9b": {
    repo: "IndexTeam/Index-Translate-9B-GGUF",
    revision: "645939fbab839a656f1bc39975a872bc8ad749f8",
    sha256: "5e47c636c75de6c5065f8550869a744e049451ac591a001968872d5c8b4b7898",
    mmproj: "0c654bbb219cea5dbb80656ec506e308c82b06aac7287f7636b9b6d06a44b957",
  },
  "index-nailong-9b": {
    repo: "IndexTeam/Index-Nailong-9B-GGUF",
    revision: "b77c686a6063b7fd89ac781a4f349baa8d9c940a",
    sha256: "02ec1393bb42eb01332895ec79bee8b2f2439726b973aa167c37b54eac72af95",
  },
};

/** IndexTTS-2.5 as converted for audio.cpp (Q8_0, about 3.5 GB). */
const SPEECH = "index-tts-2.5";
const SPEECH_FILE = "index-tts2_5-q8_0.gguf";
const SPEECH_URL = resolveUrl(
  "audio-cpp/audio.cpp-gguf",
  "1b5981b2b89a1af578ebba5c8cf34226810e1f55",
  `IndexTTS2.5-GGUF/${SPEECH_FILE}`,
);
const SPEECH_SHA256 = "5e827b2072042e4a1b21ccf24a5cb4f71cb1011403067a0a9b039311d8b38628";

/** BS-RoFormer (ep368) as converted for audio.cpp (Q8_0, 173 MB), from the same repository and revision. */
const SEPARATION = "bs-roformer";
const SEPARATION_FILE = "bs-roformer-ep368-q8_0.gguf";
const SEPARATION_URL = resolveUrl(
  "audio-cpp/audio.cpp-gguf",
  "1b5981b2b89a1af578ebba5c8cf34226810e1f55",
  `BS-RoFormer-ep368-GGUF/${SEPARATION_FILE}`,
);
const SEPARATION_SHA256 = "9a55a8cad369d00f6e0fb208bb0cd87e30e25430772b8491e20a4eace6423ad2";

/**
 * SaT 3L-SM (segment-any-text/sat-3l-sm, MIT) as an 8-bit ONNX export with the XLM-RoBERTa tokenizer
 * (about 250 MB), which `POST /segment` runs (src/segment.ts) to find sentences for reading aloud. The files are
 * called alike in every such repository, so they go into a directory of their own in MODELS_DIR.
 */
const SEGMENTATION = "sat-3l-sm";
export const SEGMENTATION_DIR = "sat-3l-sm";
const SEGMENTATION_REPO = "jiangzhuo9357/sat-3l-sm-onnx";
const SEGMENTATION_REVISION = "7698b9e41fef7a1e24638b9aaff2108ce1020657";
const SEGMENTATION_FILES: Record<string, string> = {
  "model.onnx": "1132546a16fa1aa9da218602049c6e7aeba0ec5b76409131446f40ebda2be99f",
  // FacebookAI/xlm-roberta-base's tokenizer, unmodified.
  "tokenizer.json": "a898ea75433890f6610f4e470b8ebeb0c21dce5c8dd61f892eb09eb5919d2e2c",
};

/**
 * LaBSE (sentence-transformers/LaBSE, Apache-2.0) as Xenova's 8-bit ONNX export (`model_quantized.onnx`,
 * 470 MB, which ends at the encoder's last hidden state) with its WordPiece vocabulary, and the
 * sentence-transformers pooling layer (Dense 768 → 768, tanh) that the export leaves out. `POST /align`
 * runs it (src/segment.ts) to match the sentences of a source and its translation.
 */
const ALIGNMENT = "labse";
export const ALIGNMENT_DIR = "labse";
const LABSE_ONNX = (file: string) => resolveUrl("Xenova/LaBSE", "147002d501fc76ecd313c631999ea796520fea74", file);
const ALIGNMENT_FILES: Record<string, { url: string; sha256: string }> = {
  "model.onnx": {
    url: LABSE_ONNX("onnx/model_quantized.onnx"),
    sha256: "2d209704455c8e5718dbef9c46ca22c823eb35256b74b4122d90845310c7ef82",
  },
  "vocab.txt": {
    url: LABSE_ONNX("vocab.txt"),
    sha256: "7453247caa2cf23116c1da332bec0cc1c9ef896b7803591a62ad2007b7a33c33",
  },
  "dense.safetensors": {
    url: resolveUrl(
      "sentence-transformers/LaBSE",
      "836121a0533e5664b21c7aacc5d22951f2b8b25b",
      "2_Dense/model.safetensors",
    ),
    sha256: "f866c945fa2147ce4940c8ead0b4b20af4217e0f4664bd35f41c2a0967c4fe77",
  },
};

// IndexTTS has no built-in voices: a voice is a short reference recording that it imitates. These
// are the speaker prompts of the official demo.
const VOICES_URL = "/spaces/IndexTeam/IndexTTS-2-Demo/resolve/b01840e8e4fd9753743a6d0466cd73ae1d634a68/examples";
const VOICES: Record<string, string> = {
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
};

/** What the user is shown before a model is downloaded; THIRD_PARTY_NOTICES.md has the full account. */
export const NOTICES: Record<string, string> = {
  "index-translate-9b": [
    "Index-Translate-9B (IndexTeam / bilibili), GGUF Q6_K, and its image encoder (mmproj, GGUF Q8_0)",
    "  License: Apache-2.0",
    "  https://huggingface.co/IndexTeam/Index-Translate-9B-GGUF",
  ].join("\n"),
  "index-nailong-9b": [
    "Index-NativeLong-9B (IndexTeam / bilibili), GGUF Q6_K",
    "  License: Apache-2.0",
    "  https://huggingface.co/IndexTeam/Index-Nailong-9B-GGUF",
  ].join("\n"),
  [SPEECH]: [
    "IndexTTS-2.5 (bilibili), GGUF Q8_0 converted by audio.cpp, and the example voices",
    "  License: bilibili Model Use License Agreement (NOT Apache or MIT). Among its terms:",
    "   - a separate license from bilibili is needed above 100 million monthly active users or",
    "     RMB 1 billion annual revenue (yours or your affiliates')",
    "   - not to be used to improve other AI models, except non-commercial ones",
    "   - no use that breaks the law, and no high-risk use (medical diagnosis, autonomous driving,",
    "     military, critical infrastructure, large-scale biometric surveillance, automated decisions)",
    "   - you answer for what you make with it, including other people's rights in an imitated voice",
    "   - bilibili may revoke the license on breach; Chinese law applies",
    "  Full text: https://huggingface.co/IndexTeam/IndexTTS-2.5/blob/main/LICENSE",
    "  Example voices: speaker prompts of https://huggingface.co/spaces/IndexTeam/IndexTTS-2-Demo",
    "  (Apache-2.0 on its card; the speakers' own rights are not stated). Use only voices you may use.",
  ].join("\n"),
  [SEPARATION]: [
    "BS-RoFormer ep368, GGUF Q8_0 converted by audio.cpp",
    "  License: Apache-2.0 per audio.cpp's model license list (checkpoint source undocumented there)",
    "  https://github.com/0xShug0/audio.cpp/blob/main/docs/model_licenses.md",
  ].join("\n"),
  [SEGMENTATION]: [
    "SaT 3L-SM (segment-any-text), 8-bit ONNX export by jiangzhuo9357, with the tokenizer of xlm-roberta-base",
    "  License: MIT (the weights, wtpsplit's code, and the XLM-RoBERTa tokenizer)",
    "  https://huggingface.co/jiangzhuo9357/sat-3l-sm-onnx",
  ].join("\n"),
  [ALIGNMENT]: [
    "LaBSE (Google, via sentence-transformers), 8-bit ONNX export by Xenova, with its vocabulary and pooling layer",
    "  License: Apache-2.0",
    "  https://huggingface.co/sentence-transformers/LaBSE, https://huggingface.co/Xenova/LaBSE",
  ].join("\n"),
};

export const MODEL_IDS = [...Object.keys(TRANSLATION), SPEECH, SEPARATION, SEGMENTATION, ALIGNMENT];

/** An error whose message is all the user needs: it is printed without a stack trace. */
export class FetchError extends Error {}

/** `--model` values and what is left, which are the server's settings. */
export function parseArgs(argv: readonly string[]): { ids: string[]; rest: string[] } {
  const ids: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--model") {
      const id = argv[++i];
      if (id === undefined) {
        throw new FetchError("--model needs a value");
      }
      ids.push(id);
    } else if (arg.startsWith("--model=")) {
      ids.push(arg.slice("--model=".length));
    } else {
      rest.push(arg);
    }
  }
  for (const id of ids) {
    if (!MODEL_IDS.includes(id)) {
      throw new FetchError(`unknown model "${id}"; models are ${MODEL_IDS.join(", ")}`);
    }
  }
  return { ids: ids.length > 0 ? ids : MODEL_IDS, rest };
}

/** What the chosen models consist of, and where each file goes. */
export function plan(
  ids: readonly string[],
  dirs: { models: string; speechModel: string; separationModel: string; voices: string },
): Download[] {
  const files: Download[] = [];
  for (const id of ids) {
    const pin = TRANSLATION[id];
    if (pin) {
      const { file, mmproj } = MODELS.find((m) => m.id === id)!;
      files.push({ url: resolveUrl(pin.repo, pin.revision, file), sha256: pin.sha256, dest: join(dirs.models, file) });
      if (pin.mmproj && mmproj) {
        files.push({
          url: resolveUrl(pin.repo, pin.revision, mmproj),
          sha256: pin.mmproj,
          dest: join(dirs.models, mmproj),
        });
      }
    } else if (id === SEPARATION) {
      files.push({
        url: SEPARATION_URL,
        sha256: SEPARATION_SHA256,
        dest: join(dirs.separationModel, SEPARATION_FILE),
      });
    } else if (id === SEGMENTATION) {
      for (const [name, sha256] of Object.entries(SEGMENTATION_FILES)) {
        files.push({
          url: resolveUrl(SEGMENTATION_REPO, SEGMENTATION_REVISION, name),
          sha256,
          dest: join(dirs.models, SEGMENTATION_DIR, name),
        });
      }
    } else if (id === ALIGNMENT) {
      for (const [name, { url, sha256 }] of Object.entries(ALIGNMENT_FILES)) {
        files.push({ url, sha256, dest: join(dirs.models, ALIGNMENT_DIR, name) });
      }
    } else {
      files.push({ url: SPEECH_URL, sha256: SPEECH_SHA256, dest: join(dirs.speechModel, SPEECH_FILE) });
      for (const [name, sha256] of Object.entries(VOICES)) {
        files.push({ url: `${VOICES_URL}/${name}`, sha256, dest: join(dirs.voices, name), keep: true });
      }
    }
  }
  return files;
}

/**
 * Makes `file.dest` the pinned file: kept when it is already there and right, downloaded
 * otherwise, to `<dest>.part` first so that only a verified file ever has the real name.
 */
export async function fetchFile(
  file: Download,
  endpoint: string,
  curl: string,
  log: (line: string) => void,
): Promise<void> {
  if (existsSync(file.dest)) {
    const got = await fileSha256(file.dest);
    if (got === file.sha256) {
      return log(`ok ${file.dest}`);
    }
    if (file.keep) {
      return log(`kept ${file.dest} (not the example voice of that name)`);
    }
    throw new FetchError(
      `${file.dest} is not the expected file (SHA-256 ${got}, not ${file.sha256}); delete it and run this again`,
    );
  }

  const part = `${file.dest}.part`;
  const url = endpoint + file.url;
  await mkdir(dirname(file.dest), { recursive: true });
  log(`downloading ${url}`);
  const child = Bun.spawn(
    [
      curl,
      "--fail",
      "--location",
      "--retry",
      "3",
      // Goes on from the bytes that an earlier, interrupted run left in the .part file.
      "--continue-at",
      "-",
      ...(process.stderr.isTTY ? ["--progress-bar"] : ["--silent", "--show-error"]),
      "--output",
      part,
      url,
    ],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  const code = await child.exited;
  // 22 is an HTTP error, which is also what a .part file that is already complete gets (416 for the
  // empty range that is left to fetch), so there the file decides.
  const got = existsSync(part) && (code === 0 || code === 22) ? await fileSha256(part) : "";
  if (got === file.sha256) {
    await rename(part, file.dest);
    return log(`ok ${file.dest}`);
  }
  if (code !== 0) {
    throw new FetchError(
      `the download of ${url} failed (curl exit code ${code}); check the network connection and run this again${
        existsSync(part) ? ", which continues where it stopped" : ""
      }`,
    );
  }
  // Not kept: continuing a wrong file would never give the right one.
  await rm(part);
  throw new FetchError(
    `${url} is not the expected file (SHA-256 ${got}, not ${file.sha256}); what was downloaded is deleted, run this again`,
  );
}

/** Standard input's next line after `question`; empty at the end of input. */
async function readLine(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) {
    return line;
  }
  return "";
}

/**
 * Prints the notice of every model in `ids` that still has a file to download and asks for "yes".
 * Throws FetchError unless the answer is "yes"; asks nothing when there is nothing to download.
 */
export async function acceptNotices(
  ids: readonly string[],
  dirs: Parameters<typeof plan>[1],
  log: (line: string) => void,
  ask: (question: string) => Promise<string>,
): Promise<void> {
  const needed = ids.filter((id) => plan([id], dirs).some((f) => !existsSync(f.dest)));
  if (needed.length === 0) {
    return;
  }
  log("Third-party notices for what is about to be downloaded (see also THIRD_PARTY_NOTICES.md):\n");
  for (const id of needed) {
    log(`${NOTICES[id]}\n`);
  }
  const answer = (await ask('Type "yes" to accept these terms and download: ')).trim().toLowerCase();
  if (answer !== "yes") {
    throw new FetchError("the terms were not accepted; nothing was downloaded");
  }
}

/** Downloads what `argv` asks for. Throws FetchError with the reason when something is not as pinned. */
export async function fetchModels(
  argv: readonly string[],
  env: Record<string, string | undefined> = Bun.env,
  log: (line: string) => void = console.log,
  ask: (question: string) => Promise<string> = readLine,
): Promise<void> {
  const { ids, rest } = parseArgs(argv);
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig(env, rest);
  } catch (e) {
    throw new FetchError(e instanceof Error ? e.message : String(e));
  }
  const curl = Bun.which("curl", { PATH: env.PATH ?? "" });
  if (!curl) {
    throw new FetchError(
      "curl is needed to download the models and was not found; install it (the package is called curl everywhere) and run this again",
    );
  }
  const endpoint = (env.HF_ENDPOINT || "https://huggingface.co").replace(/\/+$/, "");
  const dirs = {
    models: cfg.modelsDir,
    speechModel: cfg.speechModelDir,
    separationModel: cfg.separationModelDir,
    voices: cfg.voicesDir,
  };
  await acceptNotices(ids, dirs, log, ask);
  const files = plan(ids, dirs);
  for (const file of files) {
    await fetchFile(file, endpoint, curl, log);
  }
}

if (import.meta.main) {
  try {
    await fetchModels(Bun.argv.slice(2));
  } catch (e) {
    if (!(e instanceof FetchError)) {
      throw e;
    }
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}
