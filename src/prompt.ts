// Prompt builders matching the training-side templates of Index-Translate
// (ported from inference/llm/translate.py in bilibili/Index-Translate).

import nailongEnZh from "../prompts/nailong_en-zh.txt" with { type: "text" };
import nailongJaZh from "../prompts/nailong_ja-zh.txt" with { type: "text" };
// Fixed NativeLong templates, copied from inference/llm/prompts/ in bilibili/Index-Translate.
import nailongZhEn from "../prompts/nailong_zh-en.txt" with { type: "text" };
import nailongZhJa from "../prompts/nailong_zh-ja.txt" with { type: "text" };

const DOCUMENT_TEMPLATES: Record<string, string> = {
  "zh-en": nailongZhEn,
  "en-zh": nailongEnZh,
  "zh-ja": nailongZhJa,
  "ja-zh": nailongJaZh,
};

export const DOCUMENT_DIRECTIONS = Object.keys(DOCUMENT_TEMPLATES);

const PLACEHOLDER = /（在这里放入需要翻译的完整[^）]*原文）/;

/** The NativeLong prompt for one whole document. `direction` is one of DOCUMENT_DIRECTIONS. */
export function buildDocumentPrompt(direction: string, text: string): string {
  const template = DOCUMENT_TEMPLATES[direction];
  if (!template) throw new Error(`no document template for ${direction}`);
  // A function replacement keeps "$" sequences in the document text literal.
  return template.replace(PLACEHOLDER, () => text.trim()).trim();
}

export interface Language {
  code: string;
  name: string;
  /** Name used inside the prompt. */
  zh: string;
}

export const LANGUAGES: Language[] = [
  { code: "en", name: "English", zh: "英语" },
  { code: "zh", name: "Chinese", zh: "中文" },
  { code: "de", name: "German", zh: "德语" },
  { code: "fr", name: "French", zh: "法语" },
  { code: "es", name: "Spanish", zh: "西班牙语" },
  { code: "ja", name: "Japanese", zh: "日语" },
  { code: "ko", name: "Korean", zh: "韩语" },
  { code: "pt", name: "Portuguese", zh: "葡萄牙语" },
  { code: "ru", name: "Russian", zh: "俄语" },
  { code: "ar", name: "Arabic", zh: "阿拉伯语" },
  { code: "it", name: "Italian", zh: "意大利语" },
  { code: "nl", name: "Dutch", zh: "荷兰语" },
  { code: "pl", name: "Polish", zh: "波兰语" },
  { code: "ro", name: "Romanian", zh: "罗马尼亚语" },
  { code: "sv", name: "Swedish", zh: "瑞典语" },
  { code: "tr", name: "Turkish", zh: "土耳其语" },
  { code: "hi", name: "Hindi", zh: "印地语" },
  { code: "vi", name: "Vietnamese", zh: "越南语" },
  { code: "th", name: "Thai", zh: "泰语" },
  { code: "id", name: "Indonesian", zh: "印尼语" },
  { code: "ms", name: "Malay", zh: "马来语" },
  { code: "fil", name: "Filipino", zh: "菲律宾语" },
  { code: "uk", name: "Ukrainian", zh: "乌克兰语" },
  { code: "fa", name: "Persian", zh: "波斯语" },
  { code: "cs", name: "Czech", zh: "捷克语" },
  { code: "el", name: "Greek", zh: "希腊语" },
  { code: "da", name: "Danish", zh: "丹麦语" },
  { code: "hu", name: "Hungarian", zh: "匈牙利语" },
  { code: "fi", name: "Finnish", zh: "芬兰语" },
  { code: "nb", name: "Norwegian Bokmål", zh: "书面挪威语" },
  { code: "sk", name: "Slovak", zh: "斯洛伐克语" },
  { code: "bg", name: "Bulgarian", zh: "保加利亚语" },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l.zh]));

/** Known codes map to their prompt name; anything else is passed through as a language name. */
export function languageName(lang: string): string {
  return BY_CODE.get(lang.trim().toLowerCase()) ?? lang.trim();
}

export interface PromptInput {
  text: string;
  targetLang: string;
  /** Omitted or "auto" leaves the source language out of the prompt. */
  sourceLang?: string;
  glossary?: Record<string, string>;
  hardConstraints?: string[];
  softConstraints?: string[];
  genre?: string;
}

const HARD = "【硬性要求】";
const SOFT = "【注意】";

function constraintLines(items: string[] | undefined, tag: string, accepted: string[]): string[] {
  const out: string[] = [];
  for (const item of items ?? []) {
    for (const raw of item.split("\n")) {
      const line = raw.trim().replace(/^(?:\d+(?:[.)、]\s*|\s+)|[.\s])+/, "");
      if (!line) continue;
      out.push(accepted.some((p) => line.startsWith(p)) ? line : tag + line);
    }
  }
  return out;
}

function isJsonObject(text: string): boolean {
  if (!text.startsWith("{") || !text.endsWith("}")) return false;
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

/**
 * The text of a user message that is followed by an image whose text is to be translated, as the
 * `--image` branch of translate.py writes it. `text`, when there is any, is what to look at in the
 * image, not something to translate. Genre has no place in this prompt.
 */
export function buildImagePrompt(input: Partial<Pick<PromptInput, "text">> & Omit<PromptInput, "text">): string {
  const tgt = languageName(input.targetLang);
  const hasSource = !!input.sourceLang && input.sourceLang.trim().toLowerCase() !== "auto";
  const src = hasSource ? languageName(input.sourceLang!) : "";
  const base = `请将图片中的${src}文本翻译为${tgt}，直接输出翻译结果，不要进行任何解释。`;

  const extras: string[] = [];
  const text = input.text?.trim();
  if (text) extras.push(`【参考文本/关注内容】\n${text}`);
  extras.push(...constraintLines(input.hardConstraints, HARD, [HARD]));
  extras.push(...constraintLines(input.softConstraints, "【软性要求】", [SOFT, "【软性要求】"]));
  const terms = Object.entries(input.glossary ?? {}).map(([k, v]) => `${k.trim()}→${v.trim()}`);
  if (terms.length) extras.push(`【专名/术语对照】${terms.join("、")}`);
  if (!extras.length) return base;
  return `${base}\n\n${extras.join("\n\n")}\n\n只输出翻译结果，不要进行任何解释。`;
}

export function buildPrompt(input: PromptInput): string {
  const text = input.text.trim();
  const tgt = languageName(input.targetLang);
  const hasSource = !!input.sourceLang && input.sourceLang.trim().toLowerCase() !== "auto";
  const src = hasSource ? languageName(input.sourceLang!) : "";

  const constraints = constraintLines(input.hardConstraints, HARD, [HARD]);
  const terms = Object.entries(input.glossary ?? {}).map(([k, v]) => `${k.trim()}→${v.trim()}`);
  if (terms.length) constraints.push(`${HARD}专名/术语对照: ${terms.join("、")}`);
  constraints.push(...constraintLines(input.softConstraints, SOFT, [SOFT, "【软性要求】"]));

  if (!constraints.length) {
    return `请将以下${src}文本翻译为${tgt}，直接输出翻译结果，不要进行任何解释。\n\n${text}`;
  }

  const genre = input.genre?.trim() || "文本";
  const suffix =
    isJsonObject(text) && constraints.some((c) => /json/i.test(c))
      ? "请以相同的 JSON 格式输出翻译结果，key 保持不变，value 为对应译文。只输出 JSON，不要有任何额外说明。"
      : "只输出译文，不要有任何额外说明。";

  return (
    `请将以下${src}${genre}翻译成${tgt}，并且严格遵循所有约束要求。\n\n` +
    `【源文】\n${text}\n\n` +
    `【约束要求】\n${constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n` +
    suffix
  );
}
