import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

// Time cost of each lint rule: `bun scripts/profile_lint.ts [--runs N] [--out file.json]`.
// `bun lint --timing` only reports the total for all rules, so this lints a copy of the project once per enabled
// rule with only that rule on, and reads "ms in rules" (CPU time over all threads; parsing and type checking are not
// in it). Type-aware rules each include the same few ms of shared type-info setup, and rules that share work (the
// `import/` module graph) cost less when removed than alone. Differences of a few ms are noise.
import { $ } from "bun";

const { values } = parseArgs({ options: { runs: { type: "string", default: "5" }, out: { type: "string" } } });
const runs = Number(values.runs);
const root = resolve(import.meta.dir, "..");

const config = JSON.parse(await $`bun lint --print-config=src/app.ts --no-color`.cwd(root).text()) as {
  rules: Record<string, unknown>;
};
const severity = (level: unknown) => (level === 2 || level === "error" ? "error" : "warn");
const rules: [string, unknown[]][] = [];
for (const [name, setting] of Object.entries(config.rules)) {
  const [level, ...options] = Array.isArray(setting) ? (setting as unknown[]) : [setting];
  if (level !== 0 && level !== "off") {
    rules.push([name, [severity(level), ...options]]);
  }
}

const toml = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(toml).join(", ")}]`
    : value !== null && typeof value === "object"
      ? `{ ${Object.entries(value)
          .map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`)
          .join(", ")} }`
      : JSON.stringify(value);

const work = mkdtempSync(join(tmpdir(), "profile-lint-"));
cpSync(root, work, {
  recursive: true,
  filter: (path) => !/\/(node_modules|\.git|vendor|models|dist)(\/|$)/.test(path.slice(root.length)),
});
symlinkSync(join(root, "node_modules"), join(work, "node_modules"));

const header = `[lint]
ignorePatterns = ["src/api-schema.d.ts", "vendor/", "models/", "dist/", "playwright-report/", "test-results/"]
typeAware = true

[lint.categories]
${["correctness", "suspicious", "pedantic", "style", "perf", "restriction", "nursery"].map((c) => `${c} = "off"`).join("\n")}
`;

async function measure(rule?: [string, unknown[]]): Promise<number> {
  const body = rule ? `\n[lint.rules]\n${JSON.stringify(rule[0])} = ${toml(rule[1])}\n` : "";
  await Bun.write(join(work, "bunfig.toml"), `${header}${body}\n[fmt]\n`);
  const output = await $`bun lint --timing --no-color --quiet 2>&1`.cwd(work).nothrow().text();
  const match = /([\d.]+)ms in rules/.exec(output);
  if (!match) {
    throw new Error(`no timing for ${rule?.[0] ?? "the baseline"}:\n${output.slice(0, 500)}`);
  }
  return Number(match[1]);
}
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1]!;
async function repeat(rule?: [string, unknown[]]): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    samples.push(await measure(rule));
  }
  return samples;
}

try {
  const baseline = median(await repeat());
  const results: { rule: string; ms: number }[] = [];
  for (const rule of rules) {
    results.push({ rule: rule[0], ms: Number((median(await repeat(rule)) - baseline).toFixed(1)) });
  }
  results.sort((a, b) => b.ms - a.ms);
  console.log(`baseline (no rules): ${baseline} ms; ${rules.length} rules, median of ${runs} runs\n`);
  for (const { rule, ms } of results.slice(0, 30)) {
    console.log(`${ms.toFixed(1).padStart(7)} ms  ${rule}`);
  }
  if (values.out) {
    await Bun.write(values.out, JSON.stringify({ baseline, runs, rules: results }, null, 2));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
