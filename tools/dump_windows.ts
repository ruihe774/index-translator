// Writes ref/windows.bin: real token windows (as sat.ts builds them, [CLS] ... [SEP]) of the repo's docs,
// for tools/int8_sim.py. Format: count (i32), then per window: length (i32), ids (i32 x length).
import { readFileSync } from "node:fs";
import type * as Sat from "../../index-translator/src/sat";
import { appDir, MODEL_DIR, ROOT } from "../test/paths";

const APP = appDir();
const { XlmrTokenizer } = (await import(`${APP}/src/sat.ts`)) as typeof Sat;
const tok = new XlmrTokenizer(JSON.parse(readFileSync(`${MODEL_DIR}/tokenizer.json`, "utf8")) as Sat.TokenizerJson);
const text = ["README.md", "CLAUDE.md", "docs/markdown-conformance.md"].map((f) => readFileSync(`${APP}/${f}`, "utf8")).join("\n\n");
const { ids } = tok.encode(text);
const out: number[] = [];
let n = 0;
for (let s = 0; s + 510 <= ids.length && n < 40; s += 510, n++) out.push(512, 0, ...ids.slice(s, s + 510), 2);
await Bun.write(`${ROOT}/ref/windows.bin`, new Int32Array([n, ...out]));
console.log(n, "windows");
