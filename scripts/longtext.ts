// Long-input check against a running backend. Translates a 16K-letter English document to
// Chinese in a single generation, translates the result back, and verifies after each pass
// that no paragraph was dropped or repeated.
// Usage: [MODEL=index-nailong-9b] bun scripts/longtext.ts [base-url] [output-dir]

import { join } from "node:path";
import {
  countLetters,
  englishEssays,
  type Fixture,
  missingParagraphs,
  repeatedMarkers,
  withMarkers,
} from "../test/fixtures";

export async function translateStream(baseUrl: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/api/v1/translate`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  let translation = "";
  let start: any;
  let done: any;
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body!) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (!event || !data) continue;
      const payload = JSON.parse(data);
      if (event === "delta") translation += payload.text;
      else if (event === "start") start = payload;
      else if (event === "done") done = payload;
      else if (event === "error") throw new Error(`${payload.code}: ${payload.message}`);
    }
  }
  if (!done) throw new Error("stream ended without a done event");
  return { translation, start, done };
}

export interface PassResult {
  ok: boolean;
  translation: string;
  missing: number[];
  repeated: string[];
  finishReason: string;
}

export async function runPass(
  baseUrl: string,
  label: string,
  fixture: Fixture,
  body: Record<string, unknown>,
): Promise<PassResult> {
  const t0 = performance.now();
  const { translation, start, done } = await translateStream(baseUrl, { ...body, text: fixture.text });
  const seconds = (performance.now() - t0) / 1000;
  const missing = missingParagraphs(fixture, translation);
  const repeated = repeatedMarkers(fixture, translation);
  const ok = done.finish_reason === "stop" && missing.length === 0 && repeated.length === 0;

  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  console.log(
    `  input: ${fixture.text.length} characters (${countLetters(fixture.text)} letters), ${fixture.markers.length} paragraphs`,
  );
  console.log(`  tokens: ${start.prompt_tokens} prompt + ${done.usage.completion_tokens} completion`);
  console.log(`  output: ${translation.length} characters, finish_reason=${done.finish_reason}`);
  console.log(`  time: ${seconds.toFixed(1)} s wall, ${done.timings.tokens_per_second} tokens/s generation`);
  console.log(`  paragraphs with missing numbers: ${missing.length ? missing.join(", ") : "none"}`);
  console.log(`  repeated numbers: ${repeated.length ? repeated.join(", ") : "none"}`);
  return { ok, translation, missing, repeated, finishReason: done.finish_reason };
}

if (import.meta.main) {
  const base = (Bun.argv[2] ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
  const outDir = Bun.argv[3];

  const model = Bun.env.MODEL ? { model: Bun.env.MODEL } : {};
  const english = await englishEssays();
  const forward = await runPass(base, "English -> Chinese", english, {
    ...model,
    source_lang: "en",
    target_lang: "zh",
  });
  const back = await runPass(base, "Chinese -> English (round trip)", withMarkers(forward.translation), {
    ...model,
    source_lang: "zh",
    target_lang: "en",
  });
  if (outDir) {
    await Bun.write(join(outDir, "essays.zh.txt"), forward.translation);
    await Bun.write(join(outDir, "essays.back.en.txt"), back.translation);
  }
  process.exit(forward.ok && back.ok ? 0 : 1);
}
