// Benchmark: WebCodecs Opus encoding of a long recording in the page, as `OggOpusEncoder` (audio-upload.ts)
// does it for a re-encoded upload (transcode.ts). Measures what `opus.complexity` and `opus.application`
// cost and buy.
//
//   SECONDS=1800 REPEATS=3 bun e2e/perf/opus-encode.ts
//
// Starts the mock server, loads the page, decodes the example voices and loops them into SECONDS of real
// speech, then encodes it once per (config, repeat) through the page's own encoder. `browser default` drops
// the `opus` dictionary the page now sets (complexity 6), so the two show what that setting costs and buys.
// Nothing is asserted. Env: OPUS_BENCH_PORT (3300), SECONDS (1800), REPEATS (3).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "@playwright/test";

import type { OggOpusEncoder as Encoder } from "../../public/audio-upload";

// The page loads its modules from the server root; a variable keeps the linter from resolving it on disk.
const AUDIO_UPLOAD = "/audio-upload.ts";

const root = join(import.meta.dir, "..", "..");
const port = Number(process.env.OPUS_BENCH_PORT ?? 3300);
const seconds = Number(process.env.SECONDS ?? 1800);
const repeats = Number(process.env.REPEATS ?? 3);
const voices = ["voice_01", "voice_03", "voice_05", "voice_06", "voice_09", "voice_11"].map((name) =>
  readFileSync(join(root, "voices", `${name}.wav`)).toString("base64"),
);

/** `opus` dictionary members to force; anything unset keeps the value the config already has. */
interface OpusKnobs {
  complexity?: number;
  application?: "lowdelay";
}
interface Run {
  label: string;
  channels: 1 | 2;
  bitrate: number;
  /** Knobs to force, `null` for no `opus` dictionary at all, or unset for the page's own config. */
  opus?: OpusKnobs | null;
}
interface Result {
  run: Run;
  repeat: number;
  ms: number;
  bytes: number;
  hash: number;
  supported: boolean;
}

// The page's config (complexity 6, application audio), whether CELT-only lowdelay adds to it, and the
// browser's own default (maximum complexity) with lowdelay. Mono at 64 kbps and stereo at 96 kbps are
// transcode.ts's.
const runs: Run[] = [
  { label: "page config (6)", channels: 2, bitrate: 96_000 },
  {
    label: "6 + lowdelay",
    channels: 2,
    bitrate: 96_000,
    opus: { complexity: 6, application: "lowdelay" },
  },
  { label: "browser default", channels: 2, bitrate: 96_000, opus: null },
  {
    label: "10 + lowdelay",
    channels: 2,
    bitrate: 96_000,
    opus: { complexity: 10, application: "lowdelay" },
  },
  { label: "4 + lowdelay", channels: 2, bitrate: 96_000, opus: { complexity: 4, application: "lowdelay" } },
  { label: "2 + lowdelay", channels: 2, bitrate: 96_000, opus: { complexity: 2, application: "lowdelay" } },
  { label: "page config (6) mono", channels: 1, bitrate: 64_000 },
  {
    label: "6 + lowdelay mono",
    channels: 1,
    bitrate: 64_000,
    opus: { complexity: 6, application: "lowdelay" },
  },
];

const app = Bun.spawn(["bun", "e2e/mock-server.ts"], {
  cwd: root,
  env: { ...process.env, E2E_PORT: String(port), E2E_CONTROL_PORT: String(port + 1) },
  stdout: "ignore",
  stderr: "inherit",
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (let i = 0; ; i++) {
    if ((await fetch(`http://127.0.0.1:${port}/api/v1/health`).catch(() => null))?.ok) {
      break;
    }
    if (i === 150 || app.exitCode !== null) {
      throw new Error("the mock server did not start");
    }
    await Bun.sleep(200);
  }

  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });

  // One evaluate for the whole benchmark: the decoded speech and the warm encoder thread stay put, and the
  // runs are ordered here so repeats and configs interleave.
  const results = await page.evaluate(
    async ({ voices, seconds, repeats, runs, module }): Promise<Result[]> => {
      const { OggOpusEncoder } = (await import(module)) as { OggOpusEncoder: typeof Encoder };
      const context = new AudioContext({ sampleRate: 48_000 });
      const buffers = await Promise.all(
        voices.map((b64) => context.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer)),
      );
      await context.close();

      // Real speech, one voice after another; trimmed to whole seconds so a second can be sliced off.
      const rate = 48_000;
      const CHUNK = rate;
      let frames = buffers.reduce((n, b) => n + b.length, 0);
      frames -= frames % CHUNK;
      const planesOf = (channels: 1 | 2) => {
        const planes: Float32Array<ArrayBuffer>[] = [];
        for (let c = 0; c < channels; c++) {
          const samples = new Float32Array(frames);
          let at = 0;
          for (const b of buffers) {
            const source = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
            const take = Math.min(source.length, frames - at);
            samples.set(source.subarray(0, take), at);
            at += take;
          }
          planes.push(samples);
        }
        return planes;
      };
      const planes = { 1: planesOf(1), 2: planesOf(2) };

      // Inject `opus` into whatever config the page's encoder builds (`configure` is where it goes): knobs
      // force those members, `null` drops the dictionary (the browser default), unset keeps the page's.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the encoder as `this` below
      const { configure: original } = AudioEncoder.prototype;
      let extra: OpusKnobs | null | undefined;
      AudioEncoder.prototype.configure = function configure(this: AudioEncoder, config: AudioEncoderConfig) {
        const { opus, ...rest } = config;
        if (extra === null) {
          return original.call(this, rest);
        }
        return original.call(this, { ...rest, opus: extra === undefined ? opus : { ...opus, ...extra } });
      };
      // The Ogg muxer picks a random stream serial; a fixed one makes outputs comparable byte for byte.
      const { random } = Math;
      Math.random = () => 0.5;

      const encode = async (run: Run, want: number) => {
        const encoder = new OggOpusEncoder(run.channels, run.bitrate);
        const total = Math.round(want * rate);
        const start = performance.now();
        try {
          let at = 0;
          for (let done = 0; done < total; done += CHUNK) {
            const length = Math.min(CHUNK, total - done);
            const offset = at % frames;
            await encoder.write(planes[run.channels].map((p) => p.subarray(offset, offset + length)));
            at += length;
          }
          const out = await encoder.finish();
          const ms = performance.now() - start;
          let hash = 2_166_136_261;
          for (const byte of out) {
            hash = Math.imul(hash ^ byte, 16_777_619) >>> 0;
          }
          return { ms, bytes: out.length, hash };
        } finally {
          encoder.close();
        }
      };

      const results: Result[] = [];
      for (let repeat = 0; repeat < repeats; repeat++) {
        // Rotate the order each repeat, so a drift of the machine does not land on one config.
        const order = runs.slice(repeat % runs.length).concat(runs.slice(0, repeat % runs.length));
        for (const run of order) {
          extra = run.opus;
          const config: AudioEncoderConfig = {
            codec: "opus",
            sampleRate: 48_000,
            numberOfChannels: run.channels,
            bitrate: run.bitrate,
          };
          if (run.opus !== null) {
            // The page's config is complexity 6 (audio-upload.ts); the explicit runs take that as the base.
            config.opus = { ...config.opus, complexity: 6, ...run.opus };
          }
          const supported = (await AudioEncoder.isConfigSupported(config)).supported === true;
          // Warm up the encoder thread and the JIT on a short run before the measured one.
          await encode(run, 5);
          results.push({ run, repeat, supported, ...(await encode(run, seconds)) });
        }
      }
      AudioEncoder.prototype.configure = original;
      Math.random = random;
      return results;
    },
    { voices, seconds, repeats, runs, module: AUDIO_UPLOAD },
  );

  // Medians per config, and which outputs the browser default's bytes match (its own complexity).
  const median = (xs: number[]) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  const hashOf = (label: string) => results.find((r) => r.run.label === label)!.hash;
  console.log(`\n${seconds} s of speech, ${repeats} run(s) each, Chromium ${browser.version()}\n`);
  console.log("config                 median time   x realtime   output");
  for (const run of runs) {
    const mine = results.filter((r) => r.run.label === run.label);
    const ms = median(mine.map((r) => r.ms));
    const sameAsDefault = mine.every((r) => r.hash === hashOf("browser default"));
    console.log(
      `${run.label.padEnd(22)} ${(ms / 1000).toFixed(2).padStart(7)} s ` +
        `${(seconds / (ms / 1000)).toFixed(0).padStart(9)}x ` +
        `${(mine[0]!.bytes / 1024 / 1024).toFixed(2).padStart(6)} MiB` +
        (sameAsDefault && run.label !== "browser default" ? "  (bit-identical to browser default)" : "") +
        (mine.every((r) => r.supported) ? "" : "  [isConfigSupported says no]"),
    );
  }
  console.log(`\nbrowser default output hash: ${hashOf("browser default").toString(16)}`);
} finally {
  await browser?.close();
  app.kill();
}
