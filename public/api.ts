// What every call to the server's API shares: its base path, and a failed call as an error that
// carries the server's error body, so the page can say what went wrong in a sentence.

import { type ApiErrorBody, describeError } from "./errors.ts";

export const API = "/api/v1";

export class ApiFailure extends Error {
  constructor(
    public body: ApiErrorBody,
    public status: number,
  ) {
    super(body.message ?? `HTTP ${status}`);
  }
}

/** A failed request as a sentence for the user. */
export function failureMessage(e: unknown): string {
  if (e instanceof ApiFailure) {
    return describeError(e.body, e.status);
  }
  if (e instanceof TypeError) {
    return "The server cannot be reached.";
  }
  return e instanceof Error ? e.message : String(e);
}
