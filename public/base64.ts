// Base64 to bytes for the page and its workers. `Uint8Array.fromBase64` where the browser has it (Chrome 140,
// Firefox 133, Safari 18.2), else `atob`. Both skip ASCII whitespace and take a missing `=` padding. A
// character outside the alphabet throws: a `SyntaxError` from `fromBase64`, a `DOMException` from `atob`.
// No DOM and no Bun, so src/ may import it too, though Bun has `fromBase64` itself.

export type Base64Alphabet = "base64" | "base64url";

/** The two characters that differ between the alphabets, in base64. */
const URL_SAFE = /[-_]/g;
const URL_ONLY = /[-_]/;
const PLAIN_ONLY = /[+/]/;

/** `Uint8Array.fromBase64`, which TypeScript's DOM library does not declare yet; absent in older browsers. */
interface WithFromBase64 {
  fromBase64?: (text: string, options: { alphabet: Base64Alphabet }) => Uint8Array<ArrayBuffer>;
}

/** Decodes `text`; `alphabet` is "base64" (`+/`) or "base64url" (`-_`), never both mixed. Throws on bad input. */
export function fromBase64(text: string, alphabet: Base64Alphabet = "base64"): Uint8Array<ArrayBuffer> {
  // Looked up on each call (it is cheap), so a test can take it away.
  const native = Uint8Array as WithFromBase64;
  if (typeof native.fromBase64 === "function") {
    return native.fromBase64(text, { alphabet });
  }
  // `atob` knows only "base64": refuse the other alphabet's characters as `fromBase64` does, then map.
  if ((alphabet === "base64" ? URL_ONLY : PLAIN_ONLY).test(text)) {
    throw new SyntaxError(`not ${alphabet}`);
  }
  const binary = atob(alphabet === "base64url" ? text.replace(URL_SAFE, (c) => (c === "-" ? "+" : "/")) : text);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
