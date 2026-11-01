// A recording or video as the source: opened (open-ui.ts), confirmed in a dialog, sent to
// `POST /transcriptions`, and its transcript written into the source box as subtitles while the server
// writes it. Translate then translates it as any subtitles. The file is read here (media-file.ts): a WAV
// or Ogg Opus file is sent as it is, an Opus track of a WebM or MKV file remuxed into Ogg Opus, and what
// the server would not take re-encoded (transcode.ts). Like a page fetch, a transcription is a Run:
// Translate waits and Stop cancels it (`DELETE /transcriptions/{id}`), keeping what was written.

import type { Health } from "../src/api.ts";
import { API, ApiFailure, failureMessage, failureOf } from "./api.ts";
import { ask } from "./link-dialog.ts";
import {
  type AudioTrack,
  type Limits,
  limitsOf,
  MediaError,
  type MediaProbe,
  OGG_TYPE,
  preferredTrack,
  prepareRecording,
  probeMedia,
  type Recording,
} from "./media-file.ts";
import { megabytes } from "./open-file.ts";
import { restoreFocusAfter } from "./render.ts";
import { onPageWake, pageVisible, resumableEvents, TRANSCRIPTION_ID_HEADER } from "./resume.ts";
import { Run } from "./run.ts";
import type { TranscriptionSseEvent } from "./sse.ts";
import { setState } from "./state.ts";
import { browserDecodes } from "./transcode.ts";
import { minutes, transcriptionNotes, transcriptSrt } from "./transcription.ts";

/** `separate` of `POST /transcriptions`. */
export type Separate = "auto" | "true" | "false";

export interface TranscribeFlowDeps {
  stopButton: HTMLElement;
  translateButton: HTMLElement;
  /**
   * How the transcription is going, shown under the source box before its cue and letter count; the
   * empty string when it has ended.
   */
  progress(text: string): void;
  /** The screen reader's copy of what happens to the box: a new stage, not every segment. */
  announce(text: string): void;
  /** How it ended, with what to know about the transcript: the line about the opened file. */
  outcome(text: string, error: boolean): void;
  stopReading(): void;
  /** Empties the source and the result: the transcript is a new start, shown as subtitles as it grows. */
  begin(): void;
  /** Puts the transcript so far, SubRip text, in the source. */
  show(srt: string): void;
  /** The transcription ended, however: the source box can be edited again. */
  end(): void;
  /** After `begin`: the file and the track being transcribed, played above the transcript (media-ui.ts). */
  play(file: File, probe: MediaProbe, track: number): void;
  /** The recording that is sent, which the player plays when it cannot play the file. */
  recording(r: Recording): void;
}

export interface OpenResult {
  /** What the file note says. */
  text: string;
  error: boolean;
}

export interface TranscribeFlow {
  /** `/health` `transcribe`, as it last answered. */
  configure(transcribe: Health["transcribe"] | undefined): void;
  /**
   * Reads `file`, asks in the dialog and starts the transcription. `read` is called once the file is
   * read, before the dialog opens. Resolves with what to say about the file, or null when the dialog
   * was cancelled.
   */
  open(file: File, read: () => void): Promise<OpenResult | null>;
}

/** "Japanese · Opus · mono", "Commentary (English) · Opus · stereo · default". */
export function trackLabel(t: AudioTrack): string {
  const what = t.name && t.language ? `${t.name} (${t.language})` : (t.name ?? t.language ?? `Track ${t.number}`);
  const channels = t.channels === 1 ? "mono" : t.channels === 2 ? "stereo" : t.channels ? `${t.channels} channels` : "";
  return [what, t.codec, channels, t.isDefault ? "default" : ""].filter(Boolean).join(" · ");
}

/** The dialog's message: what the file is, where it goes, and how much of it. */
export function dialogMessage(name: string, probe: MediaProbe): string {
  const length = probe.duration === undefined ? "" : `, ${minutes(probe.duration)} long`;
  const cut =
    probe.cutAt === undefined
      ? ""
      : ` Only its first ${minutes(probe.cutAt)} are transcribed: that is as much as the server takes.`;
  return `${name}${length}. Its audio is sent to this server, which writes down what is said, with times and speakers, as subtitles in the box; Translate then translates them.${cut} This takes a while.`;
}

let fieldId = 0;

/** The dialog's fields: the track (when there is a choice) and whether to take the music out first. */
function buildFields(tracks: AudioTrack[], start: AudioTrack, separation: boolean) {
  const box = document.createElement("div");
  const id = `transcribe-${++fieldId}`;
  let radios: HTMLInputElement[] = [];
  if (tracks.length > 1) {
    const set = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Audio track";
    set.append(legend);
    radios = tracks.map((t, i) => {
      const label = document.createElement("label");
      label.className = "transcribe-track";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `${id}-track`;
      radio.value = String(t.number);
      radio.checked = t === start;
      radio.disabled = t.problem !== null;
      const text = document.createElement("span");
      text.textContent = trackLabel(t);
      label.append(radio, text);
      if (t.problem) {
        const why = document.createElement("span");
        why.className = "transcribe-why";
        why.id = `${id}-why-${i}`;
        why.textContent = t.problem;
        radio.setAttribute("aria-describedby", why.id);
        label.append(why);
      }
      set.append(label);
      return radio;
    });
    box.append(set);
  }
  let select: HTMLSelectElement | null = null;
  if (separation) {
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.htmlFor = `${id}-separate`;
    label.textContent = "Take out music first";
    select = document.createElement("select");
    select.id = `${id}-separate`;
    for (const [value, text] of [
      ["auto", "When music is heard"],
      ["true", "Always"],
      ["false", "Never"],
    ]) {
      select.add(new Option(text, value));
    }
    field.append(label, select);
    box.append(field);
  }
  return {
    box,
    track: () => Number(radios.find((r) => r.checked)?.value ?? start.number),
    separate: () => (select?.value ?? "auto") as Separate,
  };
}

/** What the status line says while the file is turned into what is sent. */
const preparing = (fraction?: number) =>
  fraction === undefined ? "Preparing the audio…" : `Preparing the audio… ${Math.floor(fraction * 100)}%`;

export function initTranscribeFlow(d: TranscribeFlowDeps): TranscribeFlow {
  let health: Health["transcribe"] | undefined;

  /** A new stage: shown under the box and said once to a screen reader. */
  function stage(text: string) {
    d.progress(text);
    d.announce(text);
  }

  /** How it ended: the progress goes, the outcome is said in the line about the file. */
  function end(text: string, error: boolean) {
    d.progress("");
    d.outcome(text, error);
  }

  /** Why no recording can be transcribed now; null when one can. */
  function unavailable(): string | null {
    if (!health) {
      return "This server does not say whether it can transcribe recordings.";
    }
    if (health.status !== "available") {
      return `Transcribing recordings is not available on this server${health.error ? `: ${health.error}` : ""}.`;
    }
    return null;
  }

  /** Follows the transcription's events until it ends; returns the segments' summary, or throws. */
  async function follow(run: Run, recording: Recording, separate: Separate) {
    const segments: Parameters<typeof transcriptSrt>[0] = [];
    let duration = 0;
    const transcribing = () =>
      segments.length > 0 && duration > 0
        ? `Transcribing… ${minutes(segments.at(-1)!.end)} of ${minutes(duration)}`
        : "Transcribing…";
    // Once Stop was pressed the status says "Stopping…" until the job's `cancelled` arrives.
    const progressUnlessStopping = (text: string) => void (run.stopped || d.progress(text));
    const stageUnlessStopping = (text: string) => void (run.stopped || stage(text));
    const events = resumableEvents<TranscriptionSseEvent>({
      signal: run.controller.signal,
      visible: pageVisible,
      wake: onPageWake,
      idHeader: TRANSCRIPTION_ID_HEADER,
      onReconnecting: () => stage("Connection lost. Reconnecting…"),
      onReconnected: () => stageUnlessStopping(transcribing()),
      connect: async (lastId, connection) => {
        const res = run.jobId
          ? await fetch(`${API}/transcriptions/${run.jobId}/events`, {
              headers: { "last-event-id": String(lastId) },
              signal: connection,
            })
          : await fetch(`${API}/transcriptions?separate=${separate}`, {
              method: "POST",
              headers: { "content-type": recording.type },
              body: recording.body,
              signal: connection,
            });
        if (!res.ok || !res.body) {
          throw await failureOf(res);
        }
        run.jobId ??= res.headers.get(TRANSCRIPTION_ID_HEADER);
        run.cancelUrl ??= run.jobId && `${API}/transcriptions/${run.jobId}`;
        return res;
      },
    });
    for await (const { event, data } of events) {
      if (event === "queued") {
        stageUnlessStopping(`Waiting in the queue, position ${data.position}…`);
      } else if (event === "start") {
        ({ duration } = data);
        progressUnlessStopping(transcribing());
      } else if (event === "stage") {
        stageUnlessStopping(data.stage === "separating" ? "Taking out the music…" : transcribing());
      } else if (event === "segment") {
        segments.push(data);
        progressUnlessStopping(transcribing());
        d.show(transcriptSrt(segments, recording.offset));
      } else if (event === "done") {
        return { done: data, segments };
      } else {
        throw new ApiFailure(data, 0);
      }
    }
    throw new Error("the connection closed before the transcription finished");
  }

  async function transcribe(
    file: File,
    probe: MediaProbe,
    track: number,
    separate: Separate,
    limits: Limits,
    ogg: boolean,
  ) {
    d.stopReading();
    const run = new Run();
    // Once the server has the recording, Stop waits for it: it finishes the step it is in (a separation,
    // or MOSS reading the whole recording before its first cue) and only then frees the GPU.
    run.onStopping = () => stage("Stopping… the server finishes its current step first.");
    setState({ running: run });
    d.begin();
    d.play(file, probe, track);
    d.stopButton.focus();
    stage(preparing());
    let shown = -1;
    try {
      const recording = await prepareRecording(file, probe, track, limits, {
        ogg,
        signal: run.controller.signal,
        onProgress: (f) => {
          // The status line is rewritten only when the whole percent changes.
          if (Math.floor(f * 100) !== shown) {
            shown = Math.floor(f * 100);
            d.progress(preparing(f));
          }
        },
      });
      d.recording(recording);
      stage(`Sending the recording (${megabytes(recording.body.size)})…`);
      const { done, segments } = await follow(run, recording, separate);
      const cues = segments.length;
      const speakers = done.speakers.length === 1 ? "1 speaker" : `${done.speakers.length} speakers`;
      const said =
        cues === 0
          ? `${file.name}: no speech was found.`
          : `${file.name}: transcribed, ${cues === 1 ? "1 cue" : `${cues} cues`}, ${speakers}. Translate turns them into subtitles in the language chosen under To.`;
      end([said, ...transcriptionNotes(done, recording)].join(" "), false);
    } catch (e) {
      const kept = " What was written so far stays in the box.";
      if (run.stopped) {
        end(`${file.name}: stopped.${kept}`, false);
      } else if (e instanceof MediaError) {
        end(`${file.name} could not be prepared. ${e.message}`, true);
      } else {
        end(`${file.name}: ${failureMessage(e)}${kept}`, true);
      }
    } finally {
      d.end();
      restoreFocusAfter(d.stopButton, d.translateButton, () => setState({ running: null }));
    }
  }

  return {
    configure(t) {
      health = t;
    },
    async open(file, read) {
      const problem = unavailable();
      if (problem || !health) {
        return { text: `${file.name} was not opened. ${problem}`, error: true };
      }
      const limits = limitsOf(health);
      // Without libopus on the server, Opus is decoded and sent as WAV.
      const ogg = health.upload_types.includes(OGG_TYPE);
      let probe: MediaProbe;
      try {
        probe = await probeMedia(file, limits, { ogg, decodes: browserDecodes });
      } catch (e) {
        if (!(e instanceof MediaError)) {
          console.error(e);
        }
        return {
          text: `${file.name} was not opened. ${e instanceof MediaError ? e.message : "It could not be read."}`,
          error: true,
        };
      }
      const start = preferredTrack(probe.tracks);
      if (!start) {
        const [only] = probe.tracks;
        const why =
          probe.tracks.length === 1 ? only!.problem : `None of its ${probe.tracks.length} audio tracks can be sent.`;
        return { text: `${file.name} cannot be transcribed. ${why}`, error: true };
      }
      read();
      const fields = buildFields(probe.tracks, start, health.separation);
      const answer = await ask({
        title: "Transcribe this recording?",
        message: dialogMessage(file.name, probe),
        target: "",
        fields: fields.box,
        choices: [{ value: "transcribe", label: "Transcribe" }],
      });
      if (answer !== "transcribe") {
        return null;
      }
      void transcribe(file, probe, fields.track(), fields.separate(), limits, ogg);
      return { text: `Opened ${file.name} to transcribe it.`, error: false };
    },
  };
}
