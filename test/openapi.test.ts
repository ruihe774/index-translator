// Lint of docs/openapi.yaml that no type can do. The codes of Error are not checked against the server
// here: ApiError takes only the spec's codes (src/app.ts), so a code the spec lacks does not compile.

import { describe, expect, test } from "bun:test";

import { spec, specText } from "./helpers/spec";

/** Paths of every object key called `key`, anywhere in the document. */
function keysNamed(node: unknown, key: string, path = "$"): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((v, i) => keysNamed(v, key, `${path}[${i}]`));
  }
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => [
      ...(k === key ? [`${path}.${k}`] : []),
      ...keysNamed(v, key, `${path}.${k}`),
    ]);
  }
  return [];
}

describe("docs/openapi.yaml", () => {
  test("parses as OpenAPI 3.1", () => {
    expect(spec.openapi).toStartWith("3.1");
  });

  test("has no 3.0-only nullable keyword", () => {
    expect(keysNamed(spec, "nullable")).toStrictEqual([]);
    expect(specText).not.toContain("nullable:");
  });
});
