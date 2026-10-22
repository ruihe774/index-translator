import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { autoThreads, inferenceThreads, MAX_AUTO_THREADS, parseCpuList, performanceCores } from "../src/cpu";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Cpu {
  /** Sibling list, e.g. "0-1"; absent when the kernel gives none. */
  siblings?: string;
  capacity?: number;
}

/** A copy of the parts of `/sys/devices` that `performanceCores` reads. */
function sysfs(cpus: Cpu[], extra: { online?: string; cpuCore?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "sysfs-"));
  roots.push(root);
  const cpuDir = join(root, "system", "cpu");
  mkdirSync(cpuDir, { recursive: true });
  writeFileSync(join(cpuDir, "online"), `${extra.online ?? `0-${cpus.length - 1}`}\n`);
  for (const [i, cpu] of cpus.entries()) {
    mkdirSync(join(cpuDir, `cpu${i}`, "topology"), { recursive: true });
    if (cpu.siblings) {
      writeFileSync(join(cpuDir, `cpu${i}`, "topology", "thread_siblings_list"), `${cpu.siblings}\n`);
    }
    if (cpu.capacity) {
      writeFileSync(join(cpuDir, `cpu${i}`, "cpu_capacity"), `${cpu.capacity}\n`);
    }
  }
  if (extra.cpuCore) {
    mkdirSync(join(root, "cpu_core"));
    writeFileSync(join(root, "cpu_core", "cpus"), `${extra.cpuCore}\n`);
  }
  return root;
}

const pair = (first: number, capacity?: number): Cpu[] => [
  { siblings: `${first}-${first + 1}`, capacity },
  { siblings: `${first}-${first + 1}`, capacity },
];

describe("parseCpuList", () => {
  test("ranges and single CPUs", () => {
    expect(parseCpuList("0-3,8,10-11\n")).toStrictEqual([0, 1, 2, 3, 8, 10, 11]);
    expect(parseCpuList("5")).toStrictEqual([5]);
    expect(parseCpuList("")).toStrictEqual([]);
    expect(parseCpuList("x,2")).toStrictEqual([2]);
  });
});

describe("performanceCores", () => {
  test("Intel hybrid: the P-cores' hyperthreads count once, the E-cores not at all", () => {
    // i5-14600KF as the kernel reports it: cpu_capacity is 1024 on every CPU, so cpu_core/cpus decides.
    const p = Array.from({ length: 6 }, (_, core) => pair(core * 2, 1024)).flat();
    const e = Array.from({ length: 8 }, (_, core) => ({ siblings: `${12 + core}`, capacity: 1024 }));
    expect(performanceCores(sysfs([...p, ...e], { cpuCore: "0-11" }))).toBe(6);
  });

  test("Arm big.LITTLE: the cores of a high capacity, the little ones left out", () => {
    const cpus = [
      ...[400, 400, 400, 400].map((capacity, i) => ({ siblings: `${i}`, capacity })),
      ...[870, 870, 870].map((capacity, i) => ({ siblings: `${4 + i}`, capacity })),
      { siblings: "7", capacity: 1024 },
    ];
    expect(performanceCores(sysfs(cpus))).toBe(4);
  });

  test("a processor that is not hybrid: every physical core", () => {
    const cpus = Array.from({ length: 8 }, (_, core) => pair(core * 2)).flat();
    expect(performanceCores(sysfs(cpus))).toBe(8);
    // Equal capacities are no hybrid either.
    expect(performanceCores(sysfs(Array.from({ length: 4 }, (_, i) => ({ siblings: `${i}`, capacity: 1024 }))))).toBe(
      4,
    );
  });

  test("without sibling information every CPU is a core", () => {
    expect(performanceCores(sysfs([{}, {}, {}, {}]))).toBe(4);
  });

  test("an offline CPU is not counted", () => {
    const cpus = Array.from({ length: 4 }, (_, i) => ({ siblings: `${i}` }));
    expect(performanceCores(sysfs(cpus, { online: "0-1,3" }))).toBe(3);
  });

  test("a CPU without a capacity makes the capacities useless", () => {
    const cpus: Cpu[] = [{ siblings: "0", capacity: 1024 }, { siblings: "1", capacity: 300 }, { siblings: "2" }];
    expect(performanceCores(sysfs(cpus))).toBe(3);
  });

  test("no sysfs: unknown", () => {
    expect(performanceCores(join(tmpdir(), "no-such-sysfs"))).toBeUndefined();
  });
});

describe("autoThreads", () => {
  test("the performance cores, but at most the usable CPUs and eight", () => {
    expect(autoThreads(6, 20)).toBe(6);
    expect(autoThreads(6, 4)).toBe(4);
    expect(autoThreads(16, 32)).toBe(MAX_AUTO_THREADS);
    expect(autoThreads(1, 1)).toBe(1);
  });

  test("unknown cores: half the CPUs", () => {
    expect(autoThreads(undefined, 20)).toBe(8);
    expect(autoThreads(undefined, 8)).toBe(4);
    expect(autoThreads(undefined, 1)).toBe(1);
  });
});

describe("inferenceThreads", () => {
  test("a configured count is used as it is", () => {
    expect(inferenceThreads(3)).toBe(3);
    expect(inferenceThreads(64)).toBe(64);
  });

  test("0 detects, within the usable CPUs", () => {
    const n = inferenceThreads(0);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(Math.min(navigator.hardwareConcurrency, MAX_AUTO_THREADS));
  });
});
