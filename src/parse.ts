// Request bodies: read, checked field by field, and turned into what the engines take. A bad field
// is an `invalid_request` naming it (docs/openapi.yaml).

import type { AlignUnit } from "./api";
import type { Config } from "./config";
import { ApiError, invalid, unavailable } from "./http";
import { MAX_IMAGE_BYTES } from "./image";
import { findModel, type ModelSpec } from "./models";
import {
  buildDocumentPrompt,
  buildImagePrompt,
  buildPrompt,
  DOCUMENT_DIRECTIONS,
  hasSourceLang,
  type PromptInput,
} from "./prompt";
import { MAX_ALIGN_CHARS, MAX_ALIGN_SENTENCES, MAX_SEGMENT_CHARS, MAX_SEGMENT_TEXTS, type Segmenter } from "./segment";
import {
  isSpeechLanguage,
  MAX_SAMPLE_BYTES,
  MAX_SPEECH_CHARS,
  MAX_SPEED,
  MAX_TRANSCRIBE_BYTES,
  MIN_SPEED,
  type SeparateMode,
  type Speech,
  SPEECH_LANGUAGES,
  type SpeechRequest,
} from "./speech";

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Longest `image` string: the largest image in base64, with room for a data URL's head. */
const MAX_IMAGE_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64;
/** The largest body any route reads: a JSON body with an image, a voice sample or a recording. A backstop for the server. */
export const MAX_REQUEST_BYTES = Math.max(MAX_BODY_BYTES + MAX_IMAGE_CHARS, MAX_SAMPLE_BYTES, MAX_TRANSCRIBE_BYTES);

/** A field the client sent: JSON `null` counts as not sent. */
export function present<T>(v: T): v is NonNullable<T> {
  return v !== undefined && v !== null;
}

export interface TranslateRequest extends PromptInput {
  model: ModelSpec;
  /**
   * The image whose text is translated: the uploaded file as parsed, the PNG made from it
   * (src/image.ts) from then on. With one, `text` may be empty and only says what to look at.
   */
  image?: Uint8Array;
  maxOutputTokens?: number;
  stream: boolean;
  /** SSE only: the translation survives a dropped connection and can be picked up again. */
  resumable: boolean;
}

export function optionalString(body: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  const v = body[field];
  if (!present(v)) {
    return undefined;
  }
  if (typeof v !== "string") {
    throw invalid(`${field} must be a string`, field);
  }
  return checkedLength(v, field, maxLength);
}

function checkedLength(v: string, field: string, maxLength: number): string {
  // JSON Schema counts code points; String.length counts UTF-16 units, so only spread when that could matter.
  if (v.length > maxLength && Array.from(v).length > maxLength) {
    throw invalid(`${field} must be at most ${maxLength} characters`, field);
  }
  return v;
}

/** A string that is not blank; a missing or non-string field is as wrong as a blank one. */
function requiredString(body: Record<string, unknown>, field: string, maxLength: number): string {
  const v = body[field];
  if (typeof v !== "string" || !v.trim()) {
    throw invalid(`${field} must be a non-empty string`, field);
  }
  return checkedLength(v, field, maxLength);
}

function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const v = body[field];
  if (!present(v)) {
    return undefined;
  }
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
    throw invalid(`${field} must be an array of strings`, field);
  }
  return v as string[];
}

/** The request's `Content-Type` without parameters, lower case; empty when there is none. */
export function mediaType(req: Request): string {
  return (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * The body, read until it passes `max` bytes, when it throws `tooLarge()`: the server's own limit
 * (MAX_REQUEST_BYTES) is that of the largest route, and a chunked body declares no length up front.
 */
export async function readBody(req: Request, max: number, tooLarge: () => ApiError): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(req.headers.get("content-length") ?? 0) > max) {
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  for (let r = await reader?.read(); r && !r.done; r = await reader!.read()) {
    const chunk = r.value as Uint8Array;
    size += chunk.length;
    if (size > max) {
      void reader!.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  const out = Bun.allocUnsafe(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** `withImage`: the body may carry an `image`, which does not count towards MAX_BODY_BYTES. */
export async function parseBody(req: Request, withImage = false): Promise<Record<string, unknown>> {
  // Browsers send a cross-site form POST as text/plain without a preflight, so only JSON is accepted.
  if (mediaType(req) !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "request body must be application/json");
  }
  const tooLarge = () => new ApiError(413, "body_too_large", `request body exceeds ${MAX_BODY_BYTES} bytes`);
  const bytes = await readBody(req, MAX_BODY_BYTES + (withImage ? MAX_IMAGE_CHARS : 0), tooLarge);
  const { length } = bytes;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalid("request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalid("request body must be a JSON object");
  }
  const fields = body as Record<string, unknown>;
  // Base64 is ASCII, so the string's length is its size in the body.
  if (length - (typeof fields.image === "string" ? fields.image.length : 0) > MAX_BODY_BYTES) {
    throw tooLarge();
  }
  return fields;
}

/** The `image` field's bytes: base64, bare or as a `data:` URL. What they are is for src/image.ts to find out. */
function optionalImage(body: Record<string, unknown>): Uint8Array | undefined {
  const v = body.image;
  if (!present(v)) {
    return undefined;
  }
  if (typeof v !== "string" || !v) {
    throw invalid("image must be a base64 string or a data: URL", "image");
  }
  if (v.length > MAX_IMAGE_CHARS) {
    throw new ApiError(413, "image_too_large", `the image is larger than ${MAX_IMAGE_BYTES} bytes`, {
      field: "image",
      max_image_bytes: MAX_IMAGE_BYTES,
    });
  }
  const base64 = v.startsWith("data:") ? v.slice(v.indexOf(",") + 1) : v;
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.length === 0) {
    throw invalid("image must be a base64 string or a data: URL", "image");
  }
  return bytes;
}

export function parseTranslateRequest(body: Record<string, unknown>, defaultModel: string): TranslateRequest {
  const image = optionalImage(body);
  if (image) {
    if (present(body.text) && typeof body.text !== "string") {
      throw invalid("text must be a string", "text");
    }
  } else if (typeof body.text !== "string" || !body.text.trim()) {
    throw invalid("text must be a non-empty string", "text");
  }
  const targetLang = optionalString(body, "target_lang", 64);
  if (!targetLang?.trim()) {
    throw invalid("target_lang must be a non-empty string", "target_lang");
  }

  const modelId = optionalString(body, "model", 64) ?? defaultModel;
  const model = findModel(modelId);
  if (!model) {
    throw invalid(`unknown model "${modelId}"; see GET /api/v1/models`, "model");
  }

  const { glossary } = body;
  if (present(glossary)) {
    if (typeof glossary !== "object" || Array.isArray(glossary)) {
      throw invalid("glossary must be an object mapping source terms to target terms", "glossary");
    }
    if (Object.values(glossary).some((v) => typeof v !== "string")) {
      throw invalid("glossary values must be strings", "glossary");
    }
  }

  const maxOutputTokens = body.max_output_tokens;
  if (present(maxOutputTokens) && (!Number.isInteger(maxOutputTokens) || (maxOutputTokens as number) < 1)) {
    throw invalid("max_output_tokens must be a positive integer", "max_output_tokens");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw invalid("stream must be a boolean", "stream");
  }
  if (body.resumable !== undefined && typeof body.resumable !== "boolean") {
    throw invalid("resumable must be a boolean", "resumable");
  }

  const input: TranslateRequest = {
    text: body.text ?? "",
    image,
    model,
    targetLang,
    sourceLang: optionalString(body, "source_lang", 64),
    glossary: (glossary as Record<string, string> | null) ?? undefined,
    hardConstraints: optionalStringArray(body, "hard_constraints"),
    softConstraints: optionalStringArray(body, "soft_constraints"),
    genre: optionalString(body, "genre", 64),
    maxOutputTokens: (maxOutputTokens as number | null) ?? undefined,
    stream: body.stream === true,
    resumable: body.resumable === true,
  };
  if (input.resumable && !input.stream) {
    throw invalid("resumable requires stream: true", "resumable");
  }
  if (image) {
    if (!model.mmproj) {
      throw invalid(`image is not supported by ${model.id}`, "image");
    }
    if (input.genre) {
      throw invalid("genre is not supported with an image", "genre");
    }
  }
  if (model.kind === "document") {
    checkDocumentRequest(input);
  }
  return input;
}

/** The document model takes a whole text in one of its fixed directions and nothing else. */
function checkDocumentRequest(input: TranslateRequest): void {
  if (!hasSourceLang(input.sourceLang)) {
    throw invalid(`source_lang is required by ${input.model.id}`, "source_lang");
  }
  const src = input.sourceLang.trim().toLowerCase();
  const tgt = input.targetLang.trim().toLowerCase();
  const direction = `${src}-${tgt}`;
  if (!DOCUMENT_DIRECTIONS.includes(direction)) {
    throw new ApiError(400, "unsupported_language_pair", `${input.model.id} does not translate ${src} to ${tgt}`, {
      field: "target_lang",
      supported: DOCUMENT_DIRECTIONS,
    });
  }
  const unsupported: [string, unknown][] = [
    ["glossary", input.glossary && Object.keys(input.glossary).length ? input.glossary : undefined],
    ["hard_constraints", input.hardConstraints?.length ? input.hardConstraints : undefined],
    ["soft_constraints", input.softConstraints?.length ? input.softConstraints : undefined],
    ["genre", input.genre],
  ];
  for (const [field, value] of unsupported) {
    if (value !== undefined) {
      throw invalid(`${field} is not supported by ${input.model.id}`, field);
    }
  }
}

/** Direction code of a document request, e.g. "zh-en". Only valid after checkDocumentRequest. */
function documentDirection(input: TranslateRequest): string {
  return `${input.sourceLang!.trim().toLowerCase()}-${input.targetLang.trim().toLowerCase()}`;
}

/** The text of the user message; a request's image follows it. */
export function promptFor(input: TranslateRequest): string {
  if (input.image) {
    return buildImagePrompt(input);
  }
  return input.model.kind === "document"
    ? buildDocumentPrompt(documentDirection(input), input.text)
    : buildPrompt(input);
}

/** `separate` of `POST /transcriptions`: `auto` (the default), `true` or `false`; `true` needs the separation model. */
export function parseSeparate(value: string | null, installed: boolean): SeparateMode {
  if (value === null || value === "auto") {
    return "auto";
  }
  if (value === "false") {
    return "off";
  }
  if (value !== "true") {
    throw invalid("separate must be auto, true or false", "separate");
  }
  if (!installed) {
    throw invalid("separate is true but the voice separation model is not installed", "separate");
  }
  return "on";
}

export function speechUnavailable(speech: Speech): ApiError {
  return unavailable("speech_unavailable", speech.error ?? "reading aloud is not available");
}

export async function parseSpeechRequest(
  body: Record<string, unknown>,
  speech: Speech,
  voicesDir: Config["voicesDir"],
): Promise<SpeechRequest> {
  const text = requiredString(body, "text", MAX_SPEECH_CHARS);
  const lang = optionalString(body, "lang", 16)?.trim().toLowerCase();
  if (!lang || !isSpeechLanguage(lang)) {
    throw new ApiError(400, "invalid_request", `lang must be one of ${SPEECH_LANGUAGES.join(", ")}`, {
      field: "lang",
      supported: SPEECH_LANGUAGES,
    });
  }
  const speed = body.speed ?? 1;
  if (typeof speed !== "number" || !(speed >= MIN_SPEED && speed <= MAX_SPEED)) {
    throw invalid(`speed must be a number from ${MIN_SPEED} to ${MAX_SPEED}`, "speed");
  }
  if (speech.state === "unavailable") {
    throw speechUnavailable(speech);
  }
  const voices = await speech.voices();
  if (voices.length === 0) {
    throw unavailable("speech_unavailable", `no voices: upload a sample or put a WAV recording into ${voicesDir}`);
  }
  const voice = optionalString(body, "voice", 128) ?? voices[0]!.id;
  if (!voices.some((v) => v.id === voice)) {
    throw invalid(`unknown voice "${voice}"; see GET /api/v1/voices`, "voice");
  }
  return { text, lang, voice, speed };
}

export function parseSegmentRequest(body: Record<string, unknown>, segmenter: Segmenter): string[] {
  const texts = optionalStringArray(body, "texts");
  if (!texts || texts.length === 0 || texts.length > MAX_SEGMENT_TEXTS) {
    throw invalid(`texts must be an array of 1 to ${MAX_SEGMENT_TEXTS} strings`, "texts");
  }
  if (texts.reduce((n, t) => n + t.length, 0) > MAX_SEGMENT_CHARS) {
    throw invalid(`texts must hold at most ${MAX_SEGMENT_CHARS} UTF-16 code units in all`, "texts");
  }
  if (segmenter.state === "unavailable") {
    throw unavailable("segment_unavailable", segmenter.error ?? "sentence segmentation is not available");
  }
  return texts;
}

export function parseAlignRequest(
  body: Record<string, unknown>,
  segmenter: Segmenter,
): { unit: AlignUnit; source: string[]; target: string[] } {
  const unit = body.unit ?? "sentences";
  if (unit !== "sentences" && unit !== "paragraphs") {
    throw invalid("unit must be sentences or paragraphs", "unit");
  }
  const sides = (["source", "target"] as const).map((field) => {
    const items = optionalStringArray(body, field);
    if (!items || items.length === 0 || items.length > MAX_ALIGN_SENTENCES) {
      throw invalid(`${field} must be an array of 1 to ${MAX_ALIGN_SENTENCES} strings`, field);
    }
    return items;
  });
  const [source, target] = sides as [string[], string[]];
  // Only paragraphs' openings are read, so their length is bounded by the body limit alone.
  if (unit === "sentences" && [...source, ...target].reduce((n, t) => n + t.length, 0) > MAX_ALIGN_CHARS) {
    throw invalid(`source and target must hold at most ${MAX_ALIGN_CHARS} UTF-16 code units in all`, "source");
  }
  if (segmenter.aligner.state === "unavailable") {
    throw unavailable("align_unavailable", segmenter.aligner.error ?? "alignment is not available");
  }
  return { unit, source, target };
}

/** The address a `POST /webpage` body names: absolute http or https, without credentials. */
export function parseWebpageUrl(body: Record<string, unknown>): URL {
  const raw = optionalString(body, "url", 8192)?.trim();
  let url: URL | undefined;
  try {
    url = raw ? new URL(raw) : undefined;
  } catch {
    // reported below
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw invalid("url must be an absolute http or https address", "url");
  }
  if (url.username || url.password) {
    throw invalid("url must not carry a user name or password", "url");
  }
  return url;
}
