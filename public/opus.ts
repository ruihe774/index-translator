// Whether this browser decodes the speech stream's Ogg Opus. The server sends it as a file, which
// the player hands to `decodeAudioData` like a WAV, so that is what is tried: a short recording
// (0.1 s of a quiet tone, made by the server's own encoder) decoded by a throwaway offline context.
// `canPlayType` would say something else, about the <audio> element and not the Web Audio decoder.
// Browsers that cannot (Safari before it learnt Ogg, any without Opus) get QOA or WAV.

export const OPUS_TYPE = "audio/ogg";

const PROBE =
  "T2dnUwACAAAAAAAAAABAlConAAAAACy0WmUBE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAAAAAAAAECUKicBAAAABJosoAEqT3B1" +
  "c1RhZ3MaAAAAaW5kZXgtdHJhbnNsYXRvciwgbWluaXNpbGsAAAAAT2dnUwAE+BMAAAAAAABAlConAgAAANfzw/AGVzgtNjIdSIF7bL3H" +
  "llWEAAF84o+e14yCpeoNFmvme4/la+AA2eF4WpEW+rFmtfz/pfMihw/dKrznsANnfApMrPj2erHhO10NzHzAMOB6McEOevBEKXTT4e3z" +
  "W0M8SJxd2CJ5MGnyi3rBwz7SYnYx9zlHtz30Ra3BLO7DABDz5GiRcwYQ8fw2oMNDKCBB8OeJaFfl1ixImQxetNx4D6RGgMg8Z8hgwMJL" +
  "f31avkfrZEH9hlfIlTzyAujH5G9kHmTpW8BImQxetSRgAFPPH/iDlAx41bfyufFQQ67JEkU9aFKvkmbU2fE9cT1Iq4SQUfdWBcXQYB9g" +
  "zVhImQxetNx4D2spQ9nWB+3UFSP3HHXWqecOqKfrGgXh77AFhxCpKMrSmL3ug8LhpxjJZEgFdPXwEebjMnvwxfhxCbUeryXBO8j8zSNe" +
  "U9VI";

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
