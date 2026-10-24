// The language selects: filled from GET /languages, and set to the remembered choice.

import type { Language } from "../src/api.ts";
import { API } from "./api.ts";
import { KEYS, stored } from "./storage.ts";

/** The short list offered when /languages could not be loaded. */
const FALLBACK: Language[] = [
  { code: "en", name: "English" },
  { code: "zh", name: "Chinese" },
  { code: "ja", name: "Japanese" },
];

function add(select: HTMLSelectElement, code: string, name: string) {
  const o = document.createElement("option");
  o.value = code;
  o.textContent = name;
  select.append(o);
}

function has(select: HTMLSelectElement, v: string | null): v is string {
  return v !== null && [...select.options].some((o) => o.value === v);
}

/**
 * Fills From (with Detect first) and To, and selects the remembered languages, else Detect and a
 * language other than the browser's. Returns a note for the person when only the short list could be offered.
 */
export async function fillLanguages(from: HTMLSelectElement, to: HTMLSelectElement): Promise<string> {
  let languages: Language[];
  let note = "";
  try {
    const res = await fetch(`${API}/languages`);
    const { languages: list } = (await res.json()) as { languages?: Language[] };
    if (!Array.isArray(list)) {
      throw new TypeError("no language list");
    }
    languages = list;
  } catch {
    languages = FALLBACK;
    note = "Could not load the full language list, so only English, Chinese and Japanese are offered.";
  }
  // "Detect" is not a language and is already in HTML. A rule separates it from the list.
  from.append(document.createElement("hr"));
  for (const l of languages) {
    add(from, l.code, l.name);
    add(to, l.code, l.name);
  }
  const savedFrom = stored(KEYS.from);
  const savedTo = stored(KEYS.to);
  from.value = has(from, savedFrom) ? savedFrom : "auto";
  const fallbackTo = navigator.language.toLowerCase().startsWith("en") ? "zh" : "en";
  to.value = has(to, savedTo) ? savedTo : has(to, fallbackTo) ? fallbackTo : to.options[0]!.value;
  return note;
}
