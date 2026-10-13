import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const specText = await Bun.file(join(root, "docs", "openapi.yaml")).text();
const spec = Bun.YAML.parse(specText) as any;

/** Paths of every object key called `key`, anywhere in the document. */
function keysNamed(node: unknown, key: string, path = "$"): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((v, i) => keysNamed(v, key, `${path}[${i}]`));
  }
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => {
      const here = k === key ? [`${path}.${k}`] : [];
      return here.concat(keysNamed(v, key, `${path}.${k}`));
    });
  }
  return [];
}

describe("docs/openapi.yaml", () => {
  test("parses as OpenAPI 3.1", () => {
    expect(String(spec.openapi)).toStartWith("3.1");
  });

  test("has no 3.0-only nullable keyword", () => {
    expect(keysNamed(spec, "nullable")).toEqual([]);
    expect(specText).not.toContain("nullable:");
  });

  test("Error.code enum covers every error code the server can send", async () => {
    const enumCodes = new Set<string>(spec.components.schemas.Error.properties.error.properties.code.enum);
    const src = await Bun.file(join(root, "src", "app.ts")).text();
    // invalid(...) is the helper for invalid_request; its own definition is excluded.
    const used = new Set([...src.matchAll(/new ApiError\(\s*\d+,\s*"([a-z_]+)"/g)].map((m) => m[1]!));
    if (/(?<!function )\binvalid\(/.test(src)) {
      used.add("invalid_request");
    }
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((code) => !enumCodes.has(code))).toEqual([]);
  });
});
