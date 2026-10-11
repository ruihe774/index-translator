// Detects translations that dropped, merged or repeated paragraphs. Pure, so bun test can import it.
//
// "Paragraph" depends on how the text is written: Western prose separates paragraphs with blank
// lines, but Chinese and Japanese text, subtitles and lists often use a single newline. The unit is
// taken from the source, and the translation is counted by the same unit, so a model that adds or
// removes blank lines does not cause a false warning. A drop and a repeat that cancel out are not
// noticed.

/** Fewer blocks than this are not worth checking. */
export const MIN_BLOCKS = 3;

export type Unit = "paragraphs" | "lines";

export interface Mismatch {
  unit: Unit;
  source: number;
  output: number;
}

const BLANK_LINE = /\n[^\S\n]*\r?\n/;

/** Blank-line separated paragraphs if the source has any blank line, otherwise one per line. */
export function unitOf(source: string): Unit {
  return BLANK_LINE.test(source.trim()) ? "paragraphs" : "lines";
}

export function countBlocks(text: string, unit: Unit): number {
  const parts = unit === "paragraphs" ? text.split(/\n[^\S\n]*(?:\r?\n[^\S\n]*)+/) : text.split(/\r?\n/);
  return parts.filter((p) => p.trim()).length;
}

/** The counts when the translation does not have as many blocks as the source, else null. */
export function paragraphMismatch(source: string, output: string): Mismatch | null {
  const unit = unitOf(source);
  const sourceBlocks = countBlocks(source, unit);
  if (sourceBlocks < MIN_BLOCKS) return null;
  const outputBlocks = countBlocks(output, unit);
  return sourceBlocks === outputBlocks ? null : { unit, source: sourceBlocks, output: outputBlocks };
}

export function mismatchMessage(m: Mismatch): string {
  const noun = m.unit === "lines" ? "lines" : "paragraphs";
  return `The source has ${m.source} ${noun} and the translation has ${m.output}. Parts may have been dropped, merged or repeated; check it against the source.`;
}
