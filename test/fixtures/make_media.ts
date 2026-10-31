// Writes the media files that test/matroska.test.ts and test/media-file.test.ts open (and e2e/transcribe.spec.ts
// drops on the page), with ffmpeg and mkvmerge (MKVToolNix) as found on PATH. Each is a few seconds of tones
// at low bitrates, so the files stay small; gaps, lacing and damaged files are written by the tests
// themselves (test/helpers/ebml.ts). The encoders are not bit-exact across versions, so a rerun may give
// other bytes; the tests check structure, not bytes.
//
//     bun test/fixtures/make_media.ts

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(import.meta.dir, "media");
const work = mkdtempSync(join(tmpdir(), "media-fixtures-"));

function run(...cmd: string[]) {
  const result = Bun.spawnSync(cmd, { stdout: "ignore", stderr: "pipe" });
  if (!result.success) {
    throw new Error(`${cmd.join(" ")}\n${result.stderr.toString()}`);
  }
}

const ffmpeg = (...args: string[]) => run("ffmpeg", "-loglevel", "error", "-y", ...args);
const tone = (hz: number, seconds: number) => ["-f", "lavfi", "-i", `sine=f=${hz}:d=${seconds}:sample_rate=48000`];
const opus = (bitrate: string) => ["-c:a", "libopus", "-b:a", bitrate];
const workFile = (name: string) => join(work, name);

try {
  mkdirSync(out, { recursive: true });

  // What a browser's MediaRecorder writes: WebM, Opus mono and VP8.
  ffmpeg(
    ...tone(440, 3),
    "-f",
    "lavfi",
    "-i",
    "testsrc=d=3:s=64x48:r=5",
    ...opus("24k"),
    "-ac",
    "1",
    "-c:v",
    "libvpx",
    "-b:v",
    "20k",
    join(out, "tone.webm"),
  );

  // Several audio tracks beside a video: Opus stereo English, Opus mono Japanese (the default) and AAC.
  ffmpeg(...tone(330, 3), ...opus("32k"), "-ac", "2", workFile("en.opus"));
  ffmpeg(...tone(550, 3), ...opus("24k"), "-ac", "1", workFile("ja.opus"));
  ffmpeg(...tone(660, 3), "-c:a", "aac", "-b:a", "32k", workFile("aac.m4a"));
  ffmpeg("-f", "lavfi", "-i", "testsrc=d=3:s=64x48:r=5", "-c:v", "libx264", workFile("video.mp4"));
  run(
    "mkvmerge",
    "-q",
    "-o",
    join(out, "tracks.mkv"),
    workFile("video.mp4"),
    "--language",
    "0:en",
    "--track-name",
    "0:Commentary",
    "--default-track-flag",
    "0:no",
    workFile("en.opus"),
    "--language",
    "0:ja",
    "--default-track-flag",
    "0:yes",
    workFile("ja.opus"),
    "--language",
    "0:fr",
    workFile("aac.m4a"),
  );

  // 5.1 Opus (channel mapping family 1), which the server does not take: mixed down to stereo.
  ffmpeg(
    ...tone(440, 2),
    "-af",
    "pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0",
    ...opus("64k"),
    join(out, "surround.mkv"),
  );

  // Audio that starts 1.5 s into the file, and audio that starts 20 s in.
  run("mkvmerge", "-q", "-o", join(out, "late.mkv"), "--sync", "0:1500", workFile("ja.opus"));
  run("mkvmerge", "-q", "-o", join(out, "very-late.mkv"), "--sync", "0:20000", workFile("ja.opus"));

  // A track compressed in the file (mkvmerge does this only when asked).
  run("mkvmerge", "-q", "-o", join(out, "compressed.mkv"), "--compression", "0:zlib", workFile("ja.opus"));

  // Codecs that are re-encoded: Vorbis (the default), FLAC, MP3, PCM, and AC-3, which Chromium does not decode.
  const t44 = (hz: number) => ["-f", "lavfi", "-i", `sine=f=${hz}:d=2:sample_rate=44100`];
  ffmpeg(...t44(330), "-ac", "2", "-c:a", "libvorbis", "-q:a", "0", workFile("vorbis.mka"));
  ffmpeg(...tone(440, 2), "-ar", "16000", "-ac", "1", "-c:a", "flac", workFile("flac.mka"));
  ffmpeg(...t44(550), "-ac", "1", "-c:a", "libmp3lame", "-b:a", "32k", workFile("mp3.mka"));
  ffmpeg(...tone(660, 2), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", workFile("pcm.wav"));
  ffmpeg(...tone(770, 2), "-ac", "2", "-c:a", "ac3", "-b:a", "96k", workFile("ac3.mka"));
  const english = (name: string, file: string, isDefault = false) => [
    "--language",
    "0:en",
    "--track-name",
    `0:${name}`,
    "--default-track-flag",
    isDefault ? "0:yes" : "0:no",
    workFile(file),
  ];
  run(
    "mkvmerge",
    "-q",
    "-o",
    join(out, "codecs.mkv"),
    ...english("Vorbis", "vorbis.mka", true),
    ...english("FLAC", "flac.mka"),
    ...english("MP3", "mp3.mka"),
    ...english("PCM", "pcm.wav"),
    ...english("AC-3", "ac3.mka"),
  );

  // AAC whose timestamps skip half a second at 1 s (a recorder that lost audio); ffmpeg writes no block
  // durations, so the gap is found from AAC's frame length.
  ffmpeg(
    ...t44(660),
    "-af",
    "asetpts='if(gte(T,1),PTS+0.5/TB,PTS)'",
    "-c:a",
    "aac",
    "-b:a",
    "32k",
    join(out, "gap.mka"),
  );

  // Ogg Opus and WAV, opened as they are.
  ffmpeg(...tone(440, 2), ...opus("24k"), "-ac", "1", join(out, "tone.ogg"));
  ffmpeg(...tone(440, 2), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", join(out, "tone.wav"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
