// docs/openapi.yaml as a document, for the tests that read what the generated types cannot say
// (numbers, defaults, which statuses an operation documents). Only the parts those tests read.

import { join } from "node:path";

import { root } from "./harness";

const METHODS = ["get", "post", "put", "delete", "patch"] as const;

interface SpecSchema {
  properties?: Record<string, SpecSchema>;
  default?: unknown;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

interface SpecOperation {
  responses: Record<string, unknown>;
}

interface Spec {
  openapi: string;
  servers: { url: string }[];
  paths: Record<string, Partial<Record<(typeof METHODS)[number], SpecOperation>>>;
  components: { schemas: Record<string, SpecSchema> };
}

export const specText = await Bun.file(join(root, "docs", "openapi.yaml")).text();

export const spec = Bun.YAML.parse(specText) as Spec;

/** The properties of a component schema. */
export function properties(name: string): Record<string, SpecSchema> {
  return spec.components.schemas[name]!.properties!;
}

/** Every documented operation. */
export const OPERATIONS = Object.entries(spec.paths).flatMap(([path, item]) =>
  METHODS.filter((method) => item[method]).map((method) => ({ path, method })),
);
