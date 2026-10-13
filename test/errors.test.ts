import { describe, expect, test } from "bun:test";

import { describeError } from "../public/errors";

// The same grouping the browser uses, so the expected numbers match on any locale.
const fmt = (n: number) => n.toLocaleString();

describe("describeError: input_too_long", () => {
  test("with prompt_tokens and max_input_tokens, states both counts", () => {
    expect(
      describeError(
        {
          code: "input_too_long",
          message: "the input exceeds the token limit",
          details: { prompt_tokens: 12_345, max_input_tokens: 4096 },
        },
        413,
      ),
    ).toBe(
      `The text is too long for one translation: ${fmt(12_345)} tokens, and the limit is ${fmt(4096)}. Shorten it or translate it in parts.`,
    );
  });

  test("without details, gives the generic length message", () => {
    expect(describeError({ code: "input_too_long", message: "x" }, 413)).toBe(
      "The text is too long for one translation. Shorten it or translate it in parts.",
    );
  });

  test("with only one of the two counts, falls back to the generic message", () => {
    expect(describeError({ code: "input_too_long", details: { prompt_tokens: 10 } }, 413)).toBe(
      "The text is too long for one translation. Shorten it or translate it in parts.",
    );
    expect(describeError({ code: "input_too_long", details: { max_input_tokens: 10 } }, 413)).toBe(
      "The text is too long for one translation. Shorten it or translate it in parts.",
    );
  });
});

describe("describeError: queue_full", () => {
  test("with details", () => {
    expect(describeError({ code: "queue_full", details: { position: 3 } }, 429)).toBe(
      "The translator is busy and its queue is full. Try again in a minute.",
    );
  });

  test("without details", () => {
    expect(describeError({ code: "queue_full" }, 429)).toBe(
      "The translator is busy and its queue is full. Try again in a minute.",
    );
  });
});

describe("describeError: engine_unavailable", () => {
  test("with details", () => {
    expect(describeError({ code: "engine_unavailable", details: { state: "loading" } }, 503)).toBe(
      "The translation engine is loading or switching models. Try again in a moment.",
    );
  });

  test("without details", () => {
    expect(describeError({ code: "engine_unavailable" }, 503)).toBe(
      "The translation engine is loading or switching models. Try again in a moment.",
    );
  });
});

describe("describeError: body_too_large", () => {
  test("with details", () => {
    expect(describeError({ code: "body_too_large", details: { limit: 4_194_304 } }, 413)).toBe(
      "The request is too large to send.",
    );
  });

  test("without details", () => {
    expect(describeError({ code: "body_too_large" }, 413)).toBe("The request is too large to send.");
  });
});

describe("describeError: images", () => {
  test("image_too_large says what to do, with the server's reason", () => {
    expect(describeError({ code: "image_too_large", message: "the image has more than 50000000 pixels" }, 413)).toBe(
      "The image is too large: the image has more than 50000000 pixels. Make it smaller and open it again.",
    );
    expect(describeError({ code: "image_too_large" }, 413)).toBe(
      "The image is too large. Make it smaller and open it again.",
    );
  });

  test("image_unavailable names the server as the place to fix it", () => {
    expect(describeError({ code: "image_unavailable", message: "the image encoder is not at /m/x.gguf" }, 503)).toBe(
      "Images cannot be translated on this server: the image encoder is not at /m/x.gguf.",
    );
  });
});

describe("describeError: other recognised codes keep the server message", () => {
  for (const code of [
    "invalid_request",
    "unsupported_language_pair",
    "engine_error",
    "internal_error",
    "not_found",
    "method_not_allowed",
    "unsupported_media_type",
    "forbidden_origin",
    "forbidden_host",
    "cancelled",
  ]) {
    test(`${code} with a message`, () => {
      expect(describeError({ code, message: "server says so" }, 400)).toBe("server says so");
    });

    test(`${code} without a message uses the HTTP fallback`, () => {
      expect(describeError({ code }, 400)).toBe("The server answered with an error (HTTP 400).");
    });
  }
});

describe("describeError: bare 429 and 503 (no recognised code)", () => {
  test("429 without a body says the translator is busy", () => {
    expect(describeError(undefined, 429)).toBe("The translator is busy. Try again in a minute.");
  });

  test("429 with an unrecognised code says the translator is busy", () => {
    expect(describeError({ code: "rate_limited", message: "slow down" }, 429)).toBe(
      "The translator is busy. Try again in a minute.",
    );
  });

  test("503 without a body says the translator is not ready or busy", () => {
    expect(describeError(undefined, 503)).toBe("The translator is not ready or is busy. Try again in a moment.");
  });

  test("503 with an unrecognised code says the translator is not ready or busy", () => {
    expect(describeError({ code: "maintenance", message: "down for upkeep" }, 503)).toBe(
      "The translator is not ready or is busy. Try again in a moment.",
    );
  });

  test("a recognised code still wins over the status", () => {
    expect(describeError({ code: "queue_full" }, 503)).toBe(
      "The translator is busy and its queue is full. Try again in a minute.",
    );
  });
});

describe("describeError: fallbacks", () => {
  test("uses the server message for other statuses", () => {
    expect(describeError({ message: "the model is missing" }, 500)).toBe("the model is missing");
  });

  test("names the HTTP status when there is no message", () => {
    expect(describeError({}, 500)).toBe("The server answered with an error (HTTP 500).");
    expect(describeError(undefined, 502)).toBe("The server answered with an error (HTTP 502).");
  });

  test("with no body and no status, says something went wrong", () => {
    expect(describeError(undefined)).toBe("Something went wrong.");
    expect(describeError({})).toBe("Something went wrong.");
  });

  test("an error event (status 0) keeps its message", () => {
    expect(describeError({ code: "engine_error", message: "generation failed" }, 0)).toBe("generation failed");
  });

  test("an error event with no message and status 0 says something went wrong", () => {
    expect(describeError({ code: "internal_error" }, 0)).toBe("Something went wrong.");
  });
});
