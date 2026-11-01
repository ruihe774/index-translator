// Recordings and videos opened to be transcribed: the dialog (track, music), the transcript growing in
// the source as subtitles with a Speaker column while Translate waits, Stop, and the translation of the
// transcript with its speakers put back; then what is re-encoded in the browser (other codecs, 5.1, a gap,
// a server without libopus), checked on the body sent. The files are test/fixtures/media/ (make_media.ts
// beside them); the mock speech engine answers `segments`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, type Mock, test, THINK } from "./fixtures";

const MEDIA = join(import.meta.dirname, "..", "test", "fixtures", "media");

function pick(page: Page, name: string, mimeType = "") {
  return page.locator("#open-file").setInputFiles({ name, mimeType, buffer: readFileSync(join(MEDIA, name)) });
}

const SEGMENTS = [
  { start: 0.2, end: 1.1, speaker: "S01", text: "Hello there." },
  { start: 1.3, end: 2, speaker: "S02", text: "How are you?" },
  { start: 2.1, end: 2.9, speaker: "S01", text: "Fine, thanks." },
];

const dialog = (page: Page) => page.getByRole("dialog", { name: "Transcribe this recording?" });
const rows = (page: Page, view: string) => page.locator(`${view} tbody tr`);
const note = (page: Page) => page.locator("#file-note");
/** The text box by id: it holds the source also while the preview is shown in its place. */
const box = (page: Page) => page.locator("#text");

test("a video's audio track is transcribed into the source as subtitles, then translated", async ({ app, mock }) => {
  await mock.set({ speech: { segments: SEGMENTS, segmentDelayMs: 300 } });
  await app.open();
  await pick(app.page, "tracks.mkv", "video/x-matroska");

  const d = dialog(app.page);
  await expect(d).toBeVisible();
  await expect(d).toHaveAccessibleDescription(/tracks\.mkv, 0:03 long\. Its audio is sent to this server/);
  const tracks = d.getByRole("group", { name: "Audio track" }).getByRole("radio");
  await expect(tracks).toHaveCount(3);
  // The default Opus track is chosen; AAC can be too (re-encoded).
  await expect(d.getByRole("radio", { name: "Japanese · Opus · mono · default" })).toBeChecked();
  await expect(d.getByRole("radio", { name: /^French · AAC/ })).toBeEnabled();
  await d.getByRole("radio", { name: "Commentary (English) · Opus · stereo" }).check();
  await d.getByLabel("Take out music first").selectOption("false");
  await d.getByRole("button", { name: "Transcribe" }).click();

  // While it runs Translate waits and Stop is offered; rows come in with a Speaker column.
  await expect(app.stop).toBeVisible();
  await expect(app.translate).toHaveAttribute("aria-disabled", "true");
  await expect(rows(app.page, "#source-view").first()).toBeVisible();
  await expect(app.page.locator("#source-view th")).toHaveText(["#Cue", "Time", "Sp.Speaker", "Text"]);
  // How it goes is said under the source, before the cue count; the translation's status line stays empty.
  await expect(app.page.locator("#count")).toHaveText(/^Transcribing… 0:0\d of 0:03 · [12] cues, \d+ letters$/);
  await expect(app.meta).toHaveText("");
  await expect(rows(app.page, "#source-view")).toHaveCount(3);
  await expect(note(app.page)).toHaveText(
    "tracks.mkv: transcribed, 3 cues, 2 speakers. Translate turns them into subtitles in the language chosen under To.",
  );
  await expect(app.page.locator("#count")).toHaveText(/^3 cues, \d+ letters$/);
  await expect(app.translate).toHaveAttribute("aria-disabled", "false");
  await expect(box(app.page)).toHaveValue(/^1\n00:00:00,200 --> 00:00:01,100\nS01: Hello there\.\n/);
  await expect(rows(app.page, "#source-view").nth(1).locator(".cue-speaker")).toHaveText("S02");
  await expect(rows(app.page, "#source-view").nth(1).locator(".cue-text")).toHaveText("How are you?");
  expect((await mock.state()).speech.transcriptions).toMatchObject([{ separate: "off" }]);

  // Translating sends the text without the speakers and puts them back; cues joined by the model name
  // each of their speakers, one per line.
  await mock.set({ chunks: [THINK, "1\n你好。你好吗？\n\n2\n\n3\n很好，谢谢。"] });
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  const { requests } = await mock.state();
  expect(requests[0]!.prompt).toContain("1\nHello there.\n\n2\nHow are you?\n\n3\nFine, thanks.");
  expect(requests[0]!.prompt).not.toContain("S01");
  await expect(rows(app.page, "#output")).toHaveCount(2);
  await expect(rows(app.page, "#output").locator(".cue-speaker")).toHaveText(["S01S02", "S01"]);
  await expect(rows(app.page, "#output").first().locator(".cue-speaker br")).toHaveCount(1);
  await expect(rows(app.page, "#output").first().locator(".cue-text")).toHaveText("你好。你好吗？");
});

test("Stop keeps what was written and gives the box back", async ({ app, mock }) => {
  await mock.set({ speech: { segments: SEGMENTS, segmentDelayMs: 800 } });
  await app.open();
  await pick(app.page, "tone.webm", "video/webm");
  await dialog(app.page).getByRole("button", { name: "Transcribe" }).click();
  await expect(rows(app.page, "#source-view")).toHaveCount(1);
  await app.stop.click();
  // The server stops at its next check (here the next segment, 0.8 s on): until then the page says so.
  await expect(app.page.locator("#count")).toContainText("Stopping… the server finishes its current step first.");
  await expect(app.stop).toBeVisible();
  await expect(note(app.page)).toHaveText("tone.webm: stopped. What was written so far stays in the box.");
  await expect(app.page.locator("#count")).toHaveText(/^1 cues, \d+ letters$/);
  await expect(app.translate).toHaveAttribute("aria-disabled", "false");
  await expect(app.translate).toBeFocused();
  await expect(rows(app.page, "#source-view")).toHaveCount(1);
  await app.page.getByRole("group", { name: "Source view" }).getByRole("button", { name: "Raw" }).click();
  await expect(app.text).toBeEditable();
});

test("a second Stop gives up waiting for the server", async ({ app, mock }) => {
  await mock.set({ speech: { segments: SEGMENTS, segmentDelayMs: 5000 } });
  await app.open();
  await pick(app.page, "tone.webm", "video/webm");
  await dialog(app.page).getByRole("button", { name: "Transcribe" }).click();
  await expect(app.page.locator("#count")).toContainText("Transcribing…");
  await app.stop.click();
  await expect(app.page.locator("#count")).toContainText("Stopping…");
  await app.stop.click();
  await expect(note(app.page)).toHaveText("tone.webm: stopped. What was written so far stays in the box.");
  await expect(app.translate).toHaveAttribute("aria-disabled", "false");
});

test("Cancel sends nothing; a recording that cannot be sent is not asked about", async ({ app, mock }) => {
  const api: string[] = [];
  app.page.on("request", (r) => {
    if (new URL(r.url()).pathname.includes("/transcriptions")) {
      api.push(r.url());
    }
  });
  await app.open();
  await app.text.fill("kept");
  await pick(app.page, "tone.ogg", "audio/ogg");
  await expect(dialog(app.page)).toHaveAccessibleDescription(/^tone\.ogg, 0:02 long\./);
  // Only one track, and no choice of it.
  await expect(dialog(app.page).getByRole("radio")).toHaveCount(0);
  await dialog(app.page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(app.page)).toBeHidden();
  await expect(app.text).toHaveValue("kept");
  await expect(note(app.page)).toBeHidden();

  await pick(app.page, "compressed.mkv");
  await expect(note(app.page)).toHaveText(
    "compressed.mkv cannot be transcribed. It is compressed inside the file, which is not supported.",
  );
  await expect(dialog(app.page)).toBeHidden();
  expect(api).toStrictEqual([]);
  expect((await mock.state()).speech.transcriptions).toStrictEqual([]);
});

test("a failed transcription says why and keeps the cues written", async ({ app, mock }) => {
  await mock.set({ speech: { segments: SEGMENTS.slice(0, 1), transcribeFailWith: "the model fell over" } });
  await app.open();
  await pick(app.page, "tone.wav", "audio/wav");
  await dialog(app.page).getByRole("button", { name: "Transcribe" }).click();
  await expect(note(app.page)).toContainText("tone.wav: ");
  await expect(note(app.page)).toContainText("the model fell over");
  await expect(note(app.page)).toContainText("What was written so far stays in the box.");
  await expect(note(app.page)).toHaveClass(/error/);
  await expect(rows(app.page, "#source-view")).toHaveCount(1);
});

test("without transcription on the server, a recording is refused when opened", async ({ app, mock }) => {
  await mock.set({ speech: { transcribeProblem: "the transcription model is not installed" } });
  await app.open();
  await expect(app.page.locator("#open-file")).not.toHaveAttribute("accept", /\.mkv/);
  await pick(app.page, "tone.webm", "video/webm");
  await expect(note(app.page)).toHaveText(
    "tone.webm was not opened. Transcribing recordings is not available on this server: the transcription model is not installed.",
  );
});

/** What the server read of each recording sent to it, in order. */
async function sent(mock: Mock) {
  return (await mock.state()).speech.transcriptions.map((t) => t.recording!);
}

/** Opens `name`, picks the track named `track` when given, and transcribes it to the end. */
async function transcribe(page: Page, name: string, track?: string | RegExp) {
  await pick(page, name);
  const d = dialog(page);
  if (track) {
    await d.getByRole("radio", { name: track }).check();
  }
  await d.getByRole("button", { name: "Transcribe" }).click();
  await expect(note(page)).toContainText(`${name}: transcribed`);
}

test.describe("re-encoded in the browser", () => {
  test.beforeEach(async ({ mock }) => {
    await mock.set({ speech: { segments: SEGMENTS.slice(0, 1) } });
  });

  test("AAC with a gap: decoded, the gap filled, sent as Ogg Opus", async ({ app, mock }) => {
    await app.open();
    await transcribe(app.page, "gap.mka");
    // A second of tone, half a second missing, a second of tone: the times stay the file's.
    const [r] = await sent(mock);
    expect(r).toMatchObject({ type: "audio/ogg", channels: 1 });
    expect(r!.seconds).toBeGreaterThan(2.45);
    expect(r!.seconds).toBeLessThan(2.6);
  });

  test("5.1 Opus is mixed down to stereo", async ({ app, mock }) => {
    await app.open();
    await transcribe(app.page, "surround.mkv");
    const [r] = await sent(mock);
    expect(r).toMatchObject({ type: "audio/ogg", channels: 2 });
    expect(r!.seconds).toBeCloseTo(2, 1);
  });

  test("a codec this browser cannot decode is listed with the reason", async ({ app }) => {
    await app.open();
    await pick(app.page, "codecs.mkv");
    const d = dialog(app.page);
    await expect(d.getByRole("radio", { name: "Vorbis (English) · Vorbis · stereo · default" })).toBeChecked();
    const ac3 = d.getByRole("radio", { name: /^AC-3/ });
    await expect(ac3).toBeDisabled();
    await expect(ac3).toHaveAccessibleDescription("This browser cannot decode AC-3 audio.");
  });

  for (const [track, channels] of [
    ["Vorbis", 2],
    ["FLAC", 1],
    ["MP3", 1],
    ["PCM", 1],
  ] as const) {
    test(`a ${track} track is sent as Ogg Opus`, async ({ app, mock }) => {
      await app.open();
      await transcribe(app.page, "codecs.mkv", new RegExp(`^${track} \\(English\\)`));
      const [r] = await sent(mock);
      expect(r).toMatchObject({ type: "audio/ogg", channels });
      expect(r!.seconds).toBeCloseTo(2, 1);
    });
  }

  test("without libopus on the server, Opus is decoded and sent as a mono 44.1 kHz WAV", async ({ app, mock }) => {
    await app.page.route("**/api/v1/health*", async (route) => {
      const res = await route.fetch();
      const health = (await res.json()) as { transcribe?: { upload_types: string[] } };
      if (health.transcribe) {
        health.transcribe.upload_types = ["audio/wav"];
      }
      await route.fulfill({ response: res, json: health });
    });
    await app.open();
    await transcribe(app.page, "tone.ogg");
    await transcribe(app.page, "tracks.mkv", /^Commentary/);
    const [ogg, mkv] = await sent(mock);
    expect(ogg).toMatchObject({ type: "audio/wav", channels: 1, sampleRate: 44_100 });
    expect(ogg!.seconds).toBeCloseTo(2, 1);
    expect(mkv).toMatchObject({ type: "audio/wav", channels: 1, sampleRate: 44_100 });
    expect(mkv!.seconds).toBeCloseTo(3, 1);
  });

  test("without the codecs' dequeue event, the waits fall back to a task", async ({ app, mock }) => {
    await app.page.addInitScript(() => {
      for (const codec of [AudioDecoder, AudioEncoder]) {
        delete (codec.prototype as { ondequeue?: unknown }).ondequeue;
      }
    });
    await app.open();
    await transcribe(app.page, "surround.mkv");
    const [r] = await sent(mock);
    expect(r).toMatchObject({ type: "audio/ogg", channels: 2 });
    expect(r!.seconds).toBeCloseTo(2, 1);
  });

  test("without AudioEncoder, a re-encoded track goes as WAV", async ({ app, mock }) => {
    await app.page.addInitScript(() => {
      Object.defineProperty(window, "AudioEncoder", { value: undefined });
    });
    await app.open();
    await transcribe(app.page, "surround.mkv");
    const [r] = await sent(mock);
    expect(r).toMatchObject({ type: "audio/wav", channels: 1, sampleRate: 44_100 });
    expect(r!.seconds).toBeCloseTo(2, 1);
  });
});

/** The pitch the page hears from a playing player, in Hz: the loudest bin of a Web Audio analyser. */
function pitch(page: Page, selector: string): Promise<number> {
  return page.evaluate(async (sel) => {
    const el = document.querySelector<HTMLMediaElement>(sel)!;
    const ctx = new AudioContext();
    await ctx.resume();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    ctx.createMediaElementSource(el).connect(analyser);
    // Real audio time: the analyser needs some of the tone (README: a fixed wait only for what nothing shows).
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 400);
    });
    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    let loudest = 0;
    bins.forEach((x, i) => {
      if (x > bins[loudest]!) {
        loudest = i;
      }
    });
    return (loudest * ctx.sampleRate) / analyser.fftSize;
  }, selector);
}

const playFrom = (page: Page) => page.getByRole("toolbar", { name: "Play the recording from" }).getByRole("button");

test("the video plays above its transcript with the transcribed track, the cue at the playhead marked", async ({
  app,
  mock,
}) => {
  await mock.set({ speech: { segments: SEGMENTS } });
  await app.open();
  await pick(app.page, "tracks.mkv", "video/x-matroska");
  // Not the first audio track, which Chromium would play: the others are hidden from it.
  await dialog(app.page)
    .getByRole("radio", { name: /^French · AAC/ })
    .check();
  await dialog(app.page).getByRole("button", { name: "Transcribe" }).click();
  const video = app.page.locator("#source-media video");
  await expect(video).toHaveAttribute("aria-label", "Recording: tracks.mkv");
  await expect(note(app.page)).toHaveText(/^tracks\.mkv: transcribed/);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);

  await expect
    .poll(() => playFrom(app.page).evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label"))))
    .toStrictEqual([
      "Play from: 0:00:00 Hello there.",
      "Play from: 0:00:01 How are you?",
      "Play from: 0:00:02 Fine, thanks.",
    ]);
  await playFrom(app.page).nth(1).click();
  await expect(rows(app.page, "#source-view").nth(1)).toHaveAttribute("aria-current", "time");
  await expect(playFrom(app.page).nth(1)).toHaveAttribute("aria-current", "true");
  // The French track's tone, 660 Hz (the first audio track's is 330 Hz).
  expect(Math.abs((await pitch(app.page, "#source-media video")) - 660)).toBeLessThan(30);
  await expect(rows(app.page, "#source-view").nth(2)).toHaveAttribute("aria-current", "time");
  await expect(rows(app.page, "#source-view").nth(1)).not.toHaveAttribute("aria-current");

  // Raw shows the text box under the player, without the column; Clear takes the player away.
  await app.page.getByRole("group", { name: "Source view" }).getByRole("button", { name: "Raw" }).click();
  await expect(video).toBeVisible();
  await expect(playFrom(app.page)).toHaveCount(0);
  await app.page.locator("#clear").click();
  await expect(app.page.locator("#source-media")).toBeHidden();
  await expect(app.page.locator("#source-media video")).toHaveCount(0);
});

/** The video's caption tracks: label, mode and cue texts. */
const captionTracks = (page: Page) =>
  page.locator("#source-media video").evaluate((v: HTMLVideoElement) =>
    [...v.textTracks].map((t) => ({
      label: t.label,
      lang: t.language,
      mode: t.mode,
      cues: [...(t.cues ?? [])].map((c) => [(c as VTTCue).startTime, (c as VTTCue).endTime, (c as VTTCue).text]),
    })),
  );

test("the video carries the transcript, its translation and both as caption tracks", async ({ app, mock }) => {
  await mock.set({ speech: { segments: SEGMENTS } });
  await app.open();
  await app.from.selectOption("en");
  await app.to.selectOption("zh");
  await pick(app.page, "tracks.mkv", "video/x-matroska");
  await dialog(app.page).getByRole("button", { name: "Transcribe" }).click();
  await expect(note(app.page)).toHaveText(/^tracks\.mkv: transcribed/);
  // The transcript, without its speaker ids, shown.
  await expect
    .poll(() => captionTracks(app.page))
    .toStrictEqual([
      {
        label: expect.stringMatching(/^Original \(.+\)$/),
        lang: "en",
        mode: "showing",
        cues: [
          [0.2, 1.1, "Hello there."],
          [1.3, 2, "How are you?"],
          [2.1, 2.9, "Fine, thanks."],
        ],
      },
    ]);

  // A translation adds itself and both together, which are then shown.
  await mock.set({ chunks: [THINK, "1\n你好。你好吗？\n\n2\n\n3\n很好，谢谢。"] });
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  const both = [
    [0.2, 1.1, "<lang zh>你好。你好吗？</lang>\n<lang en>Hello there.</lang>"],
    // A stretch with no original cue: the translation alone.
    [1.1, 1.3, "<lang zh>你好。你好吗？</lang>"],
    [1.3, 2, "<lang zh>你好。你好吗？</lang>\n<lang en>How are you?</lang>"],
    [2.1, 2.9, "<lang zh>很好，谢谢。</lang>\n<lang en>Fine, thanks.</lang>"],
  ];
  await expect
    .poll(() => captionTracks(app.page))
    .toStrictEqual([
      expect.objectContaining({ lang: "en", mode: "hidden" }),
      {
        label: expect.stringMatching(/^Translation \(.+\)$/),
        lang: "zh",
        mode: "hidden",
        cues: [
          [0.2, 2, "你好。你好吗？"],
          [2.1, 2.9, "很好，谢谢。"],
        ],
      },
      { label: "Original and translation", lang: "", mode: "showing", cues: both },
    ]);
  // What the reader picks in the menu stays picked through a new translation, which takes the old one's
  // tracks away first.
  await app.page.locator("#source-media video").evaluate((v: HTMLVideoElement) => {
    v.textTracks[2]!.mode = "disabled";
    v.textTracks[1]!.mode = "showing";
  });
  await app.translate.click();
  await expect(app.meta).toContainText("generated");
  await expect
    .poll(async () => (await captionTracks(app.page)).map((t) => t.mode))
    .toStrictEqual(["hidden", "showing", "hidden"]);

  await app.page.locator("#clear").click();
  await expect(app.page.locator("#source-media video")).toHaveCount(0);
});

test("a track this browser cannot play from the file is played from the recording sent", async ({ app, mock }) => {
  await mock.set({ speech: { segments: SEGMENTS } });
  // A browser without AAC in its media elements; WebCodecs still decodes it for the upload.
  await app.page.addInitScript(() => {
    const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "canPlayType")!.value as (
      this: HTMLMediaElement,
      type: string,
    ) => CanPlayTypeResult;
    HTMLMediaElement.prototype.canPlayType = function canPlayType(this: HTMLMediaElement, type: string) {
      return type.includes("mp4a") ? "" : real.call(this, type);
    };
  });
  await app.open();
  await pick(app.page, "tracks.mkv", "video/x-matroska");
  await dialog(app.page)
    .getByRole("radio", { name: /^French · AAC/ })
    .check();
  await dialog(app.page).getByRole("button", { name: "Transcribe" }).click();
  const audio = app.page.locator("#source-media audio");
  await expect(audio).toHaveAttribute("aria-label", "Transcribed audio of tracks.mkv");
  await expect(app.page.locator("#source-media video")).toHaveCount(0);
  await expect(note(app.page)).toHaveText(/^tracks\.mkv: transcribed/);
  await playFrom(app.page).nth(2).click();
  await expect(rows(app.page, "#source-view").nth(2)).toHaveAttribute("aria-current", "time");
  expect(Math.abs((await pitch(app.page, "#source-media audio")) - 660)).toBeLessThan(30);
});

test("Read aloud's column takes the place of the player's, and one sound stops the other", async ({ app, mock }) => {
  await mock.set({ speech: { segments: SEGMENTS, audioSeconds: 5 } });
  await app.open();
  await app.from.selectOption("en");
  await pick(app.page, "tone.webm", "video/webm");
  await dialog(app.page).getByRole("button", { name: "Transcribe" }).click();
  await expect(note(app.page)).toHaveText(/^tone\.webm: transcribed/);
  const video = app.page.locator("#source-media video");
  const paused = () => video.evaluate((v: HTMLVideoElement) => v.paused);
  await playFrom(app.page).first().click();
  await expect.poll(paused).toBe(false);

  const listen = app.page.locator("#listen-source");
  await listen.click();
  const read = app.page.getByRole("toolbar", { name: "Read the source text aloud from" }).getByRole("button");
  await expect(read).toHaveCount(3);
  await expect(playFrom(app.page)).toHaveCount(0);
  await expect(app.page.locator("#source-area")).toHaveClass(/with-gutter/);
  // Reading aloud pauses the player.
  await read.first().click();
  await expect.poll(paused).toBe(true);
  await expect(app.page.locator("#pause-source")).toBeVisible();

  // Released, the player's column is back; playing stops the reading.
  await listen.click();
  await expect(playFrom(app.page)).toHaveCount(3);
  await expect(app.page.locator("#source-area")).toHaveClass(/with-gutter/);
  await listen.click();
  await read.nth(1).click();
  await expect(app.page.locator("#pause-source")).toBeVisible();
  await video.evaluate((v: HTMLVideoElement) => v.play());
  await expect(app.page.locator("#pause-source")).toBeHidden();
  await expect(listen).toHaveAttribute("aria-pressed", "false");
  await expect(playFrom(app.page)).toHaveCount(3);
});

test("while the transcript grows, the play-from buttons already there stay (no blink of the current one)", async ({
  app,
  mock,
}) => {
  await mock.set({ speech: { segments: SEGMENTS, segmentDelayMs: 400 } });
  await app.open();
  await pick(app.page, "tone.webm", "video/webm");
  await dialog(app.page).getByRole("button", { name: "Transcribe" }).click();
  await expect(playFrom(app.page)).toHaveCount(1);
  await playFrom(app.page).first().click();
  // A mark on the element itself: a rebuilt button would not carry it.
  await playFrom(app.page)
    .first()
    .evaluate((b) => b.classList.add("kept"));
  await expect(playFrom(app.page)).toHaveCount(3);
  await expect(playFrom(app.page).first()).toHaveClass(/kept/);
});
