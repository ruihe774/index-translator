// Whether this browser decodes the speech stream's Ogg Opus. The server sends it as a file, which
// the player hands to `decodeAudioData` like a WAV, so that is what is tried: a short recording
// (0.1 s of a quiet tone, made by the server's own encoder) decoded by a throwaway offline context.
// `canPlayType` would say something else, about the <audio> element and not the Web Audio decoder.
// Browsers that cannot (Safari before it learnt Ogg, any without Opus) get WAV.

export const OPUS_TYPE = "audio/ogg";

const PROBE =
  "T2dnUwACAAAAAAAAAAAg5DN6AAAAAEynPkQBE09wdXNIZWFkAQF4AIA+AAAAAABPZ2dTAAAAAAAAAAAAACDkM3oBAAAAOe4YPAEpT3B1" +
  "c1RhZ3MZAAAAaW5kZXgtdHJhbnNsYXRvciwgbGlib3B1cwAAAABPZ2dTAAQ4EwAAAAAAACDkM3oCAAAA2QM4NQb9kJCRxvLYtCe9U7dO" +
  "ta6jxjeg616A6D1UpJEiaBNZ/iQYvBRdSYzrq4C3CKMFX/8IO/oRj4zBcDvvN5q937yLSWhRy+j7m092+9B6mMEAL2svdvDdqtRLO0Xe" +
  "Ff5vjObPH+5uwDm4nTIMF/gLx5gqDn21bm3tVzA5uGul8Kb0uVPNBKwOeq1BAdhm5dB776vegAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAoO87fvHft+pfBmzAalrCmPe5e4P4wWB0wSIRQ8h+GX6XRnHyS6NMGaLq84MB/HwPf0qbX3GFBH1TvZ0/7yMVrzFx" +
  "JxcVFPF+EHnNSUFs2LJAhwf1yrktjALNl7kWEDd8advbaAIGKfCiIjLDyr7ww1TeEfJC22vpk0funiVT83+btk/oLaqfJBvdx00N5EU3" +
  "7ae0BiHxj/daJ3RtA36EQuKAB00icrlI+Z3Y3424jqLPwQxIsfg2EkghcTpJCjOAAgmLhOuLRTtOI9eMIjpOlJDPWNJ61g+jPTWvDF3u" +
  "2K/pI1lYujOQdrJ506wOuF4zuaQSfGEvvvTBTsTHDBei81csbDuQXe4I50P5Mz9QfOklc3i1KZtJZGFFQ/H+DcHCeVj9NjzqDpjXlYGn" +
  "Lx8LKcBigGfWYdwRpGQeyz3Fvpr0BhVj2f3fMk/icYkD+97GNVAklE32FvyXDqqN69hvucuWKnP1shSKjQxhqEPu2LGh5SnbUaxNFfdw" +
  "SmSbqG+ATPl0Ny0vJ/bCaBT580/+gvc+5C55Oej1CTroTuw+lmE3XeQsCJzfIl44+7wsis8GRa3h6JYy1cGyOfa5sTp3pyZqvnGf/cpR" +
  "EVp+/enQHi/cuaSLZgOiDXm8l3RXCrnYVS6Iv0fXaA5M3cNhs+CLyS7dMPnE7bHjRBVqkgep7tiwRahj5gEIXCklQu5/59zfZdY2qSXi" +
  "oivp63r/fKhDyF4C0eepNY336XgtqhecjKqHIhyskrK12khabpoPzrm72omWp+2Fq+JepaFkOh4L/PnNAZz+jeOD+3VRxmP3Ku3iJHHg" +
  "4yxZgJifbyHatppgg3eRmuGRuDUbbhJKEVKvWzJhKNe8b4tTRQmFiL50EDQu/8DsAuCqoxFGhKnQtxIMjrigJCikgFj50pzOlVtKUZxD" +
  "SPwwcSD1JQR4BF1t+62+R1aL7th+ELb5HxxYBHO1pXdJ1ZFYck8YF7zPhgkAAbOaBz0nRPXF8A/SPRQAoOhKLAJdYE9LJhcK0HGqK2MW" +
  "5fZgEHstxHajyehhcjQT0j8P4pbDReD+fiN+tXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADmrdNRnC870qBMeGsdGPZVchFpCdqhHwABM" +
  "ZgCe9R6Z43TQAWy373wAAECk6cqoe8J9Jsg0";

let decodable: Promise<boolean> | undefined;

/** Whether Ogg Opus can be decoded here; found out once, on the first call. */
export function opusDecodable(): Promise<boolean> {
  decodable ??= (async () => {
    try {
      const bytes = Uint8Array.from(atob(PROBE), (c) => c.charCodeAt(0));
      const audio = await new OfflineAudioContext(1, 1, 16_000).decodeAudioData(bytes.buffer);
      return audio.length > 0;
    } catch {
      return false;
    }
  })();
  return decodable;
}
