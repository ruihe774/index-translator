// POST /transcriptions and its job routes against a mock speech engine (test/helpers/mock-speech.ts):
// what is refused before anything is queued, the events, and that a transcription outlives its
// connection, can be read again and is cancelled or forgotten only by DELETE.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { openAnonymousFiles } from "../src/anonymous-file";
import type { TranscriptionEvents, TranscriptSegment } from "../src/api";
import { type App, startApp } from "../src/app";
import {
  config,
  errorOf,
  launcher,
  mockSpeech,
  resetMockSpeech,
  silentWav,
  speechLauncher,
  until,
  waitReady,
} from "./helpers/mock-engine";

let app: App;
let base: string;

beforeAll(async () => {
  app = await startApp(config(), launcher, speechLauncher);
  base = app.server.url.origin;
  await waitReady(app);
});

afterEach(resetMockSpeech);

afterAll(() => app.stop());

type Event = {
  [E in keyof TranscriptionEvents]: { id: number; event: E; data: TranscriptionEvents[E] };
}[keyof TranscriptionEvents];

function parseEvents(text: string): Event[] {
  return text.split("\n\n").flatMap((frame) => {
    const id = /^id: (.*)$/m.exec(frame)?.[1];
    const event = /^event: (.*)$/m.exec(frame)?.[1];
    const data = /^data: (.*)$/m.exec(frame)?.[1];
    return id && event && data ? [{ id: Number(id), event, data: JSON.parse(data) as unknown } as Event] : [];
  });
}

const recording = (seconds = 2, rate = 16_000) => new Uint8Array(silentWav(seconds, rate));

function transcribe(body: Uint8Array | string = recording(), query = "", init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/api/v1/transcriptions${query}`, {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body,
    ...init,
  });
}

const SEGMENTS: TranscriptSegment[] = [
  { start: 0.2, end: 0.9, speaker: "S01", text: "Hello." },
  { start: 1, end: 1.8, speaker: "S02", text: "Hi there." },
];

describe("POST /transcriptions", () => {
  test("streams the start, the stages, each segment and the summary, with an id to read it again", async () => {
    mockSpeech.segments = SEGMENTS;
    const res = await transcribe();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    expect(res.headers.get("x-transcription-id")).toMatch(/^[0-9a-f-]{36}$/);
    const events = parseEvents(await res.text());
    expect(events.map((e) => e.id)).toStrictEqual([1, 2, 3, 4, 5, 6]);
    expect(events.map(({ event, data }) => ({ event, data }))).toStrictEqual([
      { event: "start", data: { duration: 2 } },
      { event: "stage", data: { stage: "separating" } },
      { event: "stage", data: { stage: "transcribing" } },
      { event: "segment", data: SEGMENTS[0]! },
      { event: "segment", data: SEGMENTS[1]! },
      {
        event: "done",
        data: { duration: 2, speakers: ["S01", "S02"], separated: true, trimmed: false, truncated: false },
      },
    ]);
  });

  test("separate=false skips the separation, separate=true needs its model", async () => {
    const events = parseEvents(await (await transcribe(recording(), "?separate=false")).text());
    expect(events.at(-1)).toMatchObject({ event: "done", data: { separated: false } });
    expect(events.filter((e) => e.event === "stage").map((e) => e.data)).toStrictEqual([{ stage: "transcribing" }]);
    expect(mockSpeech.transcriptions.map((t) => t.separate)).toStrictEqual(["off"]);

    mockSpeech.canSeparate = false;
    const refused = await transcribe(recording(), "?separate=true");
    expect(refused.status).toBe(400);
    await expect(errorOf(refused)).resolves.toMatchObject({ code: "invalid_request", details: { field: "separate" } });
    const bad = await transcribe(recording(), "?separate=yes");
    expect(bad.status).toBe(400);
    // `auto` without the model transcribes the recording as it is.
    const auto = parseEvents(await (await transcribe()).text());
    expect(auto.at(-1)).toMatchObject({ event: "done", data: { separated: false } });
  });

  test("a recording the engine cannot use is refused before it is queued", async () => {
    const cases: [Uint8Array | string, RegExp][] = [
      ["", /must be a WAV recording/],
      ["not a wav", /not a WAV file/],
      [recording(1, 8000), /sample rate of 8000 Hz/],
      [recording(1, 96_000), /sample rate of 96000 Hz/],
    ];
    for (const [body, message] of cases) {
      const res = await transcribe(body);
      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error).toMatchObject({ code: "invalid_request", details: { field: "body" } });
      expect(error.message).toMatch(message);
    }
    expect(mockSpeech.transcriptions).toHaveLength(0);
  });

  test("a recording over 30 minutes is refused", async () => {
    // 30 minutes and a second at 16 kHz is 55 MiB: under the byte limit, over the length.
    const res = await transcribe(recording(30 * 60 + 1));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toMatch(/too long/);
  });

  test("another media type is a 415, and an unavailable engine a 503", async () => {
    const wrong = await transcribe(recording(), "", { headers: { "content-type": "audio/mpeg" } });
    expect(wrong.status).toBe(415);
    mockSpeech.transcribeProblem = "the transcription model is not installed";
    const off = await transcribe();
    expect(off.status).toBe(503);
    await expect(errorOf(off)).resolves.toStrictEqual({
      code: "transcribe_unavailable",
      message: "the transcription model is not installed",
    });
  });

  test("an engine failure ends the stream with speech_error after the segments it sent", async () => {
    mockSpeech.segments = SEGMENTS.slice(0, 1);
    mockSpeech.transcribeFailWith = "the transcription failed: out of memory";
    const events = parseEvents(await (await transcribe()).text());
    expect(events.at(-2)?.event).toBe("segment");
    expect(events.at(-1)).toMatchObject({
      event: "error",
      data: { code: "speech_error", message: "the transcription failed: out of memory" },
    });
  });

  test("a truncated transcription says so", async () => {
    mockSpeech.truncated = true;
    const events = parseEvents(await (await transcribe()).text());
    expect(events.at(-1)).toMatchObject({ event: "done", data: { truncated: true } });
  });

  test("it shares the speech queue: a full line is a 429", async () => {
    mockSpeech.segments = SEGMENTS;
    mockSpeech.segmentDelayMs = 100;
    const first = await transcribe();
    const second = await transcribe();
    try {
      const third = await transcribe();
      expect(third.status).toBe(429);
      await third.text();
      // The waiting one hears where it stands.
      const events = parseEvents(await second.text());
      expect(events[0]).toMatchObject({ event: "queued", data: { position: 1 } });
    } finally {
      await Promise.allSettled([first.text(), second.text()]);
    }
  });
});

describe("recordings in anonymous files", () => {
  test("an upload waits as a file, which is closed when its transcription ends, however it ends", async () => {
    const before = openAnonymousFiles();
    const files = () => openAnonymousFiles() - before;
    mockSpeech.segments = SEGMENTS;
    mockSpeech.segmentDelayMs = 100;
    const first = await transcribe();
    const second = await transcribe();
    expect(files()).toBe(2);
    // A full line refuses the third, and keeps no file of it.
    expect((await transcribe()).status).toBe(429);
    expect(files()).toBe(2);
    // The waiting one is cancelled, the running one finishes.
    await fetch(`${base}/api/v1/transcriptions/${second.headers.get("x-transcription-id")}`, { method: "DELETE" });
    await Promise.all([first.text(), second.text()]);
    await until(() => files() === 0, "the files to be closed");
  });
});

describe("transcription jobs", () => {
  test("a dropped connection does not stop it, and its events are read again from any point", async () => {
    mockSpeech.segments = SEGMENTS;
    mockSpeech.segmentDelayMs = 50;
    const controller = new AbortController();
    const res = await transcribe(recording(), "", { signal: controller.signal });
    const id = res.headers.get("x-transcription-id")!;
    controller.abort();
    await res.text().catch(() => {});
    // Read again after the first event, while it runs or once it is done: the rest, through `done`.
    const again = await fetch(`${base}/api/v1/transcriptions/${id}/events`, { headers: { "last-event-id": "1" } });
    expect(again.status).toBe(200);
    const events = parseEvents(await again.text());
    expect(events[0]!.id).toBe(2);
    expect(events.at(-1)).toMatchObject({ event: "done", data: { speakers: ["S01", "S02"] } });
    // Finished, it is replayed whole.
    const whole = parseEvents(await (await fetch(`${base}/api/v1/transcriptions/${id}/events`)).text());
    expect(whole.map((e) => e.event)).toStrictEqual(["start", "stage", "stage", "segment", "segment", "done"]);
  });

  test("DELETE cancels a running one, whose reader gets `cancelled`, and then forgets it", async () => {
    mockSpeech.segments = [...SEGMENTS, ...SEGMENTS, ...SEGMENTS];
    mockSpeech.segmentDelayMs = 100;
    const res = await transcribe();
    const id = res.headers.get("x-transcription-id")!;
    const reading = res.text();
    await until(() => mockSpeech.transcriptions.length === 1);
    const del = await fetch(`${base}/api/v1/transcriptions/${id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const events = parseEvents(await reading);
    expect(events.at(-1)).toMatchObject({ event: "error", data: { code: "cancelled" } });
    expect(events.filter((e) => e.event === "segment").length).toBeLessThan(6);
    await until(async () => (await fetch(`${base}/api/v1/transcriptions/${id}/events`)).status === 404);
  });

  test("DELETE forgets a finished one", async () => {
    const res = await transcribe();
    const id = res.headers.get("x-transcription-id")!;
    await res.text();
    expect((await fetch(`${base}/api/v1/transcriptions/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${base}/api/v1/transcriptions/${id}/events`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/transcriptions/${id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("an unknown id is a 404, and a translation's id is not a transcription's", async () => {
    const unknown = await fetch(`${base}/api/v1/transcriptions/00000000-0000-4000-8000-000000000000/events`);
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).message).toMatch(/no such transcription/);
  });
});
