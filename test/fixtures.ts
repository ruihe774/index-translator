// Long-input fixture: an original, non-repetitive English document of more than 16K letters.
// Every paragraph contains at least one number of three or more digits that occurs nowhere
// else, so a translation can be checked for completeness without a reference translation.

import { join } from "node:path";

export interface Fixture {
  text: string;
  /** Numbers that must all survive translation, one group per paragraph. */
  markers: string[][];
}

export function withMarkers(text: string): Fixture {
  const paragraphs = text.trim().split(/\n\s*\n/);
  return { text: paragraphs.join("\n\n"), markers: paragraphs.map((p) => p.match(/\d{3,}/g) ?? []) };
}

export async function englishEssays(): Promise<Fixture> {
  return withMarkers(await Bun.file(join(import.meta.dir, "fixtures", "essays.en.txt")).text());
}

export function countLetters(text: string): number {
  return text.replaceAll(/[^a-zA-Z]/g, "").length;
}

/** Paragraph numbers (1-based) whose markers are not all present in `translation`. */
export function missingParagraphs(fixture: Fixture, translation: string): number[] {
  // Translations may group digits ("38,750").
  const normalized = translation.replaceAll(/(\d)[,\u00A0\u202F](?=\d{3}(?!\d))/g, "$1");
  const missing: number[] = [];
  fixture.markers.forEach((group, i) => {
    const present = group.every((m) => new RegExp(`(?<!\\d)${m}(?!\\d)`).test(normalized));
    if (!present) {
      missing.push(i + 1);
    }
  });
  return missing;
}

/** Markers that occur more often in `translation` than in the source: a sign of repeated passages. */
export function repeatedMarkers(fixture: Fixture, translation: string): string[] {
  const normalized = translation.replaceAll(/(\d)[,\u00A0\u202F](?=\d{3}(?!\d))/g, "$1");
  const count = (haystack: string, m: string) => haystack.match(new RegExp(`(?<!\\d)${m}(?!\\d)`, "g"))?.length ?? 0;
  return [...new Set(fixture.markers.flat())].filter((m) => count(normalized, m) > count(fixture.text, m));
}
