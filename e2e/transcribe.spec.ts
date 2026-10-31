// Recordings and videos opened to be transcribed: the dialog (track, music), the transcript growing in
// the source as subtitles with a Speaker column while Translate waits, Stop, and the translation of the
// transcript with its speakers put back. The files are test/fixtures/media/ (make_media.ts beside them);
// the mock speech engine answers `segments`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test, THINK } from "./fixtures";

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
  // The default Opus track is chosen; AAC is listed but cannot be.
  await expect(d.getByRole("radio", { name: "Japanese · Opus · mono · default" })).toBeChecked();
  await expect(d.getByRole("radio", { name: /^French · AAC/ })).toBeDisabled();
  await expect(d.getByRole("radio", { name: /^French · AAC/ })).toHaveAccessibleDescription(
    "AAC audio is not supported yet: only Opus tracks can be transcribed.",
  );
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

  await pick(app.page, "surround.mkv");
  await expect(note(app.page)).toHaveText(
    "surround.mkv cannot be transcribed. It has 6 channels: only mono and stereo tracks can be transcribed.",
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
