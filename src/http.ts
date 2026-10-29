// What every route shares: the API's error type, how any thrown error becomes one, and JSON responses.

import type { ErrorCode, ErrorDetails, ErrorEvent, ErrorResponse } from "./api";
import { ImageRejected } from "./image";
import { EngineError, ImageInputError, ImageUnavailableError } from "./llama";
import { SegmentError } from "./segment";
import { SpeechError } from "./speech";
import { WebpageBusyError, WebpageError, WebpageForbiddenError, WebpageUnavailableError } from "./webpage";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode | ErrorEvent["code"],
    message: string,
    public details?: ErrorDetails,
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}

/** The client went away before the request finished. Nobody reads the response, so it is not an error. */
export function cancelled(): ApiError {
  return new ApiError(499, "cancelled", "the request was cancelled");
}

/** A feature that cannot serve now (503). */
export function unavailable(code: ErrorCode, message: string, headers?: Record<string, string>): ApiError {
  return new ApiError(503, code, message, undefined, headers);
}

export function invalid(message: string, field?: string): ApiError {
  return new ApiError(400, "invalid_request", message, field ? { field } : undefined);
}

/** `T` is the schema of docs/openapi.yaml the body must have; name it at every call. */
export function json<T>(body: T, status = 200, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}

/**
 * Any error a route can throw as the API reports it. An unknown one is logged and becomes
 * `internal_error`, whose message says nothing about it. Used for a response and for an SSE `error` event.
 */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) {
    return e;
  }
  if (e instanceof ImageRejected) {
    return new ApiError(e.code === "image_too_large" ? 413 : 400, e.code, e.message, { field: "image" });
  }
  if (e instanceof ImageInputError) {
    return invalid(e.message, "image");
  }
  if (e instanceof ImageUnavailableError) {
    return new ApiError(503, "image_unavailable", e.message);
  }
  if (e instanceof EngineError) {
    return new ApiError(502, "engine_error", e.message);
  }
  if (e instanceof SpeechError) {
    return new ApiError(502, "speech_error", e.message);
  }
  if (e instanceof SegmentError) {
    return new ApiError(502, "segment_error", e.message);
  }
  if (e instanceof WebpageError) {
    return new ApiError(502, "webpage_error", e.message);
  }
  if (e instanceof WebpageForbiddenError) {
    return new ApiError(403, "forbidden_webpage", e.message);
  }
  if (e instanceof WebpageUnavailableError) {
    return new ApiError(503, "webpage_unavailable", e.message);
  }
  if (e instanceof WebpageBusyError) {
    return new ApiError(429, "queue_full", e.message, undefined, { "retry-after": "5" });
  }
  console.error("[api] unexpected error:", e);
  return new ApiError(500, "internal_error", "internal server error");
}

export function errorResponse(e: unknown): Response {
  const error = toApiError(e);
  // `cancelled` is only ever the code of an `error` event; a response nobody reads has no body.
  if (error.code === "cancelled") {
    return new Response(null, { status: error.status });
  }
  return json<ErrorResponse>(
    { error: { code: error.code, message: error.message, details: error.details } },
    error.status,
    error.headers,
  );
}

export function methodNotAllowed(allow: string): Response {
  return errorResponse(new ApiError(405, "method_not_allowed", `use ${allow}`, undefined, { allow }));
}
