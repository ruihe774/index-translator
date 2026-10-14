// What the speech request hands the player: either a file the browser decodes itself (WAV), or
// samples that were already decoded while they arrived (QOA, see qoa.ts). Pure, so the tests can
// use it without a browser.

/** 16-bit samples, interleaved. */
export interface Pcm16 {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
}

/** The audio of one piece. */
export type SpeechAudio = ArrayBuffer | Pcm16;

/** One float array per channel, -1 to 1, as `AudioBuffer.copyToChannel` takes them. */
export function splitChannels(pcm: Pcm16): Float32Array<ArrayBuffer>[] {
  const frames = Math.floor(pcm.samples.length / pcm.channels);
  const out: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < pcm.channels; c++) {
    const channel = new Float32Array(frames);
    for (let i = 0; i < frames; i++) channel[i] = pcm.samples[i * pcm.channels + c]! / 0x8000;
    out.push(channel);
  }
  return out;
}
