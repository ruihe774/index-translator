// The API's types, generated from docs/openapi.yaml into api-schema.d.ts (`bun run gen:api`).
// What the server sends and what the web app reads is typed with these, so a change of the spec
// shows up as a type error wherever the code still follows the old one. Types only: nothing here
// exists at run time, so `public/` can import it too.

import type { components } from "./api-schema";

export type { components, paths } from "./api-schema";

type Schemas = components["schemas"];

export type TranslateRequest = Schemas["TranslateRequest"];
export type TranslateResponse = Schemas["TranslateResponse"];
export type TokenizeResponse = Schemas["TokenizeResponse"];
export type ModelList = Schemas["ModelList"];
export type ModelInfo = Schemas["ModelInfo"];
export type ModelId = ModelInfo["id"];
export type ModelKind = ModelInfo["kind"];
export type FinishReason = Schemas["FinishReason"];
export type Usage = Schemas["Usage"];
export type Language = Schemas["Language"];
export type Health = Schemas["Health"];
export type SpeechStatus = Schemas["SpeechStatus"];
export type SpeechRequest = Schemas["SpeechRequest"];
export type SpeechLanguage = SpeechRequest["lang"];
export type Voice = Schemas["Voice"];
export type VoiceList = Schemas["VoiceList"];
export type SegmentStatus = Schemas["SegmentStatus"];
export type SegmentRequest = Schemas["SegmentRequest"];
export type Segmentation = Schemas["Segmentation"];
export type SegmentedText = Schemas["SegmentedText"];
export type AlignRequest = Schemas["AlignRequest"];
export type AlignUnit = Schemas["AlignUnit"];
export type Alignment = Schemas["Alignment"];
export type AlignedPair = Schemas["AlignedPair"];
export type Webpage = Schemas["Webpage"];

/** The error envelope of every error response. */
export type ErrorResponse = Schemas["Error"];
export type ErrorBody = ErrorResponse["error"];
export type ErrorDetails = Schemas["ErrorDetails"];
/** The codes of an HTTP error response; an `error` event has one more, `cancelled`. */
export type ErrorCode = ErrorBody["code"];

export type QueuedEvent = Schemas["QueuedEvent"];
export type StartEvent = Schemas["StartEvent"];
export type DeltaEvent = Schemas["DeltaEvent"];
export type DoneEvent = Schemas["DoneEvent"];
export type ErrorEvent = Schemas["ErrorEvent"];

/** The data of each Server-Sent Event of `POST /translate`, by event name. */
export interface TranslateEvents {
  queued: QueuedEvent;
  start: StartEvent;
  delta: DeltaEvent;
  done: DoneEvent;
  error: ErrorEvent;
}
