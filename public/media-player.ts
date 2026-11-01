// What the player above a transcript plays (media-ui.ts): the opened file itself where this browser can
// play the transcribed track from it, else the recording sent to the server. Pure apart from building a
// Blob, so tested by bun test (test/media-player.test.ts).
//
// A media element plays one audio track of a file, and Chromium picks the first one it can decode: it
// ignores FlagDefault and has no `audioTracks` to choose with. So the other audio tracks of a WebM or
// MKV file are hidden: their TrackType byte, audio (2), becomes 0x20 ("control"), which the player
// skips. One byte in place moves nothing else; the CRC-32 elements over the track list, which would no
// longer match, become Void elements of the same size (their ID is one byte, 0xBF to 0xEC). The Blob
// is made of the file's own slices around those bytes, so it is not a copy: it reads the file on disk.
//
// The recording (`Recording`) is the transcribed track as the server got it: always the right track,
// but audio only, and its times are the file's minus its `offset`.

import type { MediaProbe } from "./media-file.ts";
import type { Cue } from "./subtitles.ts";

/** TrackType "control", which players do not play. */
export const HIDDEN_TYPE = 0x20;
/** The Void element's ID, which takes a CRC-32's place. */
export const VOID_ID = 0xec;

/** One byte of the file to write anew. */
export interface Edit {
  at: number;
  byte: number;
}

/** The type a media element is asked about for a track of a codec (`AudioTrack.codec`); null when none fits. */
export function playbackType(container: MediaProbe["container"], codec: string): string | null {
  if (container === "wav") {
    return "audio/wav";
  }
  if (container === "ogg") {
    return 'audio/ogg; codecs="opus"';
  }
  const types: Record<string, string> = {
    Opus: 'audio/webm; codecs="opus"',
    Vorbis: 'audio/webm; codecs="vorbis"',
    AAC: 'audio/mp4; codecs="mp4a.40.2"',
    MP3: "audio/mpeg",
    FLAC: "audio/flac",
    PCM: "audio/wav",
    "AC-3": 'audio/mp4; codecs="ac-3"',
    "E-AC-3": 'audio/mp4; codecs="ec-3"',
  };
  return types[codec] ?? null;
}

/**
 * The edits that leave `track` the only audio track of a Matroska file, or null when a track that
 * would be played before it cannot be hidden (its TrackType is not where one byte can be rewritten).
 * `playable` says whether this browser plays a track: one it does not is skipped anyway.
 */
export function hideOtherAudio(probe: MediaProbe, track: number, playable: (number: number) => boolean): Edit[] | null {
  const layout = probe.matroska;
  if (!layout) {
    return [];
  }
  const others = layout.audio.filter((a) => a.number !== track);
  if (others.length === 0) {
    return [];
  }
  if (others.every((a) => a.typeAt !== undefined)) {
    return [
      ...others.map((a) => ({ at: a.typeAt!, byte: HIDDEN_TYPE })),
      ...layout.checksums.map((at) => ({ at, byte: VOID_ID })),
    ];
  }
  // Not every other track can be hidden: the file plays as it is when none before `track` is played.
  const before = layout.audio.slice(
    0,
    layout.audio.findIndex((a) => a.number === track),
  );
  return before.some((a) => playable(a.number)) ? null : [];
}

/** `file` with `edits` applied, made of slices of it: nothing of the file is read or copied. */
export function patchedFile(file: Blob, edits: readonly Edit[], type: string): Blob {
  const parts: BlobPart[] = [];
  let from = 0;
  for (const { at, byte } of [...edits].sort((a, b) => a.at - b.at)) {
    parts.push(file.slice(from, at), new Uint8Array([byte]));
    from = at + 1;
  }
  parts.push(file.slice(from));
  return new Blob(parts, { type });
}

/** What to play: the file (with `video` when it has a picture to show), or the recording once there is one. */
export type Playback = { kind: "file"; body: Blob; video: boolean } | { kind: "recording" };

/**
 * What plays `track` of a file `probeMedia` read. `canPlay` is a media element's `canPlayType` (not
 * the empty string); a track of a codec it does not play would be silent beside the picture, which
 * no event reports, so that goes to the recording.
 */
export function playbackOf(file: Blob, probe: MediaProbe, track: number, canPlay: (type: string) => boolean): Playback {
  const playable = (number: number) => {
    const codec = probe.tracks.find((t) => t.number === number)?.codec;
    const type = codec === undefined ? null : playbackType(probe.container, codec);
    return type !== null && canPlay(type);
  };
  if (!playable(track)) {
    return { kind: "recording" };
  }
  if (probe.container !== "matroska") {
    return { kind: "file", body: file, video: false };
  }
  const edits = hideOtherAudio(probe, track, playable);
  if (!edits) {
    return { kind: "recording" };
  }
  const video = probe.matroska?.video ?? false;
  const type = file.type || (video ? "video/x-matroska" : "audio/x-matroska");
  return { kind: "file", body: edits.length > 0 ? patchedFile(file, edits, type) : file, video };
}

/** The line of the cue playing at `ms`: the latest to start of those that have started and not ended; null between cues. */
export function cueAt(cues: readonly Pick<Cue, "start" | "end" | "line">[], ms: number): number | null {
  let found: Pick<Cue, "start" | "line"> | null = null;
  for (const cue of cues) {
    if (cue.start <= ms && ms < cue.end && (!found || cue.start >= found.start)) {
      found = cue;
    }
  }
  return found?.line ?? null;
}
