// Turns an API error body (and the HTTP status it came with) into a sentence for the user.
// Pure: no DOM access, so it can be unit tested.

export interface ApiErrorBody {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

const number = new Intl.NumberFormat();

export function describeError(e: ApiErrorBody | undefined, status?: number): string {
  const d = e?.details ?? {};
  switch (e?.code) {
    case "input_too_long": {
      return d.prompt_tokens && d.max_input_tokens
        ? `The text is too long for one translation: ${number.format(Number(d.prompt_tokens))} tokens, and the limit is ${number.format(Number(d.max_input_tokens))}. Shorten it or translate it in parts.`
        : "The text is too long for one translation. Shorten it or translate it in parts.";
    }
    case "queue_full": {
      return "The translator is busy and its queue is full. Try again in a minute.";
    }
    case "engine_unavailable": {
      return "The translation engine is loading or switching models. Try again in a moment.";
    }
    case "body_too_large": {
      return "The request is too large to send.";
    }
    case "image_too_large": {
      return `The image is too large${e.message ? `: ${e.message}` : ""}. Make it smaller and open it again.`;
    }
    case "image_unavailable": {
      return `Images cannot be translated on this server${e.message ? `: ${e.message}` : ""}.`;
    }
    case "speech_unavailable": {
      return `Reading aloud is not available${e.message ? `: ${e.message}` : ""}.`;
    }
    case "speech_error": {
      return `Reading aloud failed${e.message ? `: ${e.message}` : ""}.`;
    }
    case undefined: {
      break;
    }
  }
  // No recognised code: a bare 429 or 503 still tells the user the server is busy, not broken.
  if (status === 429) {
    return "The translator is busy. Try again in a minute.";
  }
  if (status === 503) {
    return "The translator is not ready or is busy. Try again in a moment.";
  }
  if (e?.message) {
    return e.message;
  }
  return status ? `The server answered with an error (HTTP ${status}).` : "Something went wrong.";
}
