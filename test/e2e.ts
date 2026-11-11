// The app's own SaT pipeline (sat.ts: tokenizer, 510-token windows with stride 256, batches of 8) with
// ONNX Runtime and with the engine as the model; compares boundary offsets and probabilities.
import { readFileSync } from "node:fs";
import type * as Ort from "../../index-translator/src/onnxruntime-ffi";
import type * as Sat from "../../index-translator/src/sat";
import { loadEngine } from "../src/engine";
import { appDir, MODEL, MODEL_DIR } from "./paths";

const APP = appDir();
const { loadRuntime } = (await import(`${APP}/src/onnxruntime-ffi.ts`)) as typeof Ort;
const { findBoundaries, XlmrTokenizer } = (await import(`${APP}/src/sat.ts`)) as typeof Sat;
const threads = Number(process.argv[2] ?? 4);
const tok = new XlmrTokenizer(JSON.parse(readFileSync(`${MODEL_DIR}/tokenizer.json`, "utf8")) as Sat.TokenizerJson);

const docs = ["README.md", "CLAUDE.md", "docs/markdown-conformance.md", "WINDOWS.md", "THIRD_PARTY_NOTICES.md"]
  .map((f) => readFileSync(`${APP}/${f}`, "utf8"));
const paragraphs = docs.flatMap((d) => d.split(/\n\s*\n/)).map((p) => p.trim()).filter((p) => p.length > 40);
const handmade = [
  "Dr. Smith arrived at 3.5 p.m. on Monday. The meeting began at once.",
  "it was done. then we left for the station",
  "No punctuation here but two sentences The second one starts here",
  "今天天气很好。我们去公园吧！明天可能会下雨，所以要带伞。",
  "東京は日本の首都です。人口は約千四百万人です。毎年多くの観光客が訪れます。",
  "Der Zug hatte Verspätung. Wir kamen erst um 23 Uhr an, z. B. wegen des Wetters. Morgen geht es weiter.",
  "Le chat dort sur le canapé. Il fait beau aujourd'hui ! Voulez-vous sortir ?",
  "ذهبت إلى السوق صباحاً. اشتريت الخبز والحليب. ثم عدت إلى البيت.",
  "Я пришёл домой поздно. Все уже спали. Утром мы поговорим.",
  "오늘은 날씨가 좋습니다. 공원에 갑시다. 내일은 비가 올 수도 있어요.",
  "😀 The first sentence is here. The second one follows it.",
  "El tren salió a las 8. Llegamos tarde, pero contentos. ¿Vienes mañana?",
];
// Long texts: whole documents (several windows each), and everything glued.
const texts = [...handmade, ...paragraphs, ...docs, docs.join("\n\n")];

const rt = loadRuntime(`${APP}/vendor/onnxruntime`);
const session = rt.open(MODEL, threads, { inputs: ["input_ids", "attention_mask"], output: "logits" });
const engine = await loadEngine(MODEL, threads);
const tokens = texts.reduce((n, t) => n + tok.encode(t).ids.length, 0);

let t0 = performance.now();
const a = findBoundaries(tok, texts, (ids, mask, rows, width) => session.run([ids, mask], rows, width, 1), 0.01)!;
const ortMs = performance.now() - t0;
t0 = performance.now();
const b = findBoundaries(tok, texts, (ids, mask, rows, width) => engine.run(ids, mask, rows, width), 0.01)!;
const wasmMs = performance.now() - t0;

let offsets = 0, diffSets = 0, decisions = 0, flips = 0, maxDp = 0;
const flipped: string[] = [];
texts.forEach((text, i) => {
  const A = new Map(a[i]!.offsets.map((o, k) => [o, a[i]!.probabilities[k]!]));
  const B = new Map(b[i]!.offsets.map((o, k) => [o, b[i]!.probabilities[k]!]));
  offsets += A.size;
  for (const o of new Set([...A.keys(), ...B.keys()])) {
    const pa = A.get(o), pb = B.get(o);
    if (pa === undefined || pb === undefined) { diffSets++; continue; }
    maxDp = Math.max(maxDp, Math.abs(pa - pb));
    decisions++;
    if (pa > 0.5 !== pb > 0.5) { flips++; flipped.push(`${JSON.stringify(text.slice(Math.max(0, o - 30), o))} ${pa} vs ${pb}`); }
  }
});
console.log(`${texts.length} texts, ${tokens} tokens, ${offsets} candidate offsets (p >= 0.01)`);
console.log(`ort ${ortMs.toFixed(0)} ms, wasm ${wasmMs.toFixed(0)} ms, threads ${threads}`);
console.log(`offsets only on one side (near the 0.01 cut): ${diffSets}; max |Δp| (3 sig. digits) ${maxDp.toFixed(4)}; flips at 0.5: ${flips}`);
flipped.forEach((f) => console.log("  ", f));
session.close();
engine.close();
