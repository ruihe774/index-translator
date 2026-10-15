// Parses the glossary textarea ("source term = target term" per line). Pure, so bun test can import
// it from the same file the browser loads.

export type GlossaryProblem =
  /** The line has no "=", or an empty source or target term. */
  | { line: number; kind: "format" }
  /** The source term already appeared on an earlier line. */
  | { line: number; kind: "duplicate"; term: string };

export interface GlossaryResult {
  /**
   * Source term to target term. The object has no prototype, so a term such as "__proto__" or
   * "constructor" is an ordinary key. JSON.stringify serializes it as a plain object.
   */
  glossary: Record<string, string>;
  /** The first line that does not parse. The glossary holds the entries before it. */
  error?: GlossaryProblem;
}

/** Splits on the first "=", so the target term may itself contain "=". Line numbers are 1-based. */
export function parseGlossary(value: string): GlossaryResult {
  const glossary = Object.create(null) as Record<string, string>;
  const all = value.split("\n");
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!.trim();
    if (!line) {
      continue;
    }
    const number = i + 1;
    const eq = line.indexOf("=");
    if (eq < 0) {
      return { glossary, error: { line: number, kind: "format" } };
    }
    const source = line.slice(0, eq).trim();
    const target = line.slice(eq + 1).trim();
    if (!source || !target) {
      return { glossary, error: { line: number, kind: "format" } };
    }
    if (Object.hasOwn(glossary, source)) {
      return { glossary, error: { line: number, kind: "duplicate", term: source } };
    }
    glossary[source] = target;
  }
  return { glossary };
}
