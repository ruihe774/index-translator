import type { Metrics, Row } from "./profiles";

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** The median of `pick` over the rows, or undefined when none has it. */
function over(rows: Row[], pick: (m: Metrics) => number | undefined): number | undefined {
  const values = rows.map((r) => pick(r.metrics)).filter((v): v is number => v !== undefined);
  return values.length ? median(values) : undefined;
}

const ms = (v: number | undefined) => (v === undefined ? "-" : `${Math.round(v)}`);

/** One line per scenario, profile, protocol and worker: medians over the repeats and the spread of the visible time. */
export function table(rows: Row[]): string {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = [row.scenario, row.profile, row.protocol, row.worker].join("\t");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const header = [
    "scenario",
    "profile",
    "proto",
    "worker",
    "n",
    "visible ms",
    "(min-max)",
    "fcp",
    "lcp",
    "synced ms",
    "reqs",
    "MB",
  ];
  const lines = [header];
  for (const [key, group] of groups) {
    const visible = group.map((r) => r.metrics.visibleMs);
    lines.push([
      ...key.split("\t"),
      String(group.length),
      ms(median(visible)),
      `${ms(Math.min(...visible))}-${ms(Math.max(...visible))}`,
      ms(over(group, (m) => m.fcpMs)),
      ms(over(group, (m) => m.lcpMs)),
      ms(over(group, (m) => m.syncMs)),
      ms(over(group, (m) => m.requests)),
      ((over(group, (m) => m.bytes) ?? 0) / 1e6).toFixed(2),
    ]);
  }
  const widths = header.map((_, col) => Math.max(...lines.map((line) => line[col]!.length)));
  return lines
    .map((line) =>
      line
        .map((cell, col) => cell.padEnd(widths[col]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
