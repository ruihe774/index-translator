// How many CPU threads inference should use. llama.cpp gives every thread an equal share of each
// matrix multiplication and waits for the slowest at every operation, so on a hybrid processor (Intel
// P and E cores, Arm big.LITTLE) a thread on a slow core holds back all the others, and a count that
// reaches into the slow cores is slower than one that stays out of them. Hyperthreads add little.
// ONNX Runtime's thread pool (sentence segmentation) behaves the same: on an i5-14600KF SaT ran
// faster with 6 threads (its P-cores) than with 8.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Most threads chosen without being asked: past about eight a matrix multiplication stops scaling. */
export const MAX_AUTO_THREADS = 8;

/** A core is a big one when its capacity is at least this fraction of the largest (3/4: Arm's mid cores count, its little ones do not). */
const BIG_CAPACITY = 0.75;

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
};

/** `0-3,8,10-11` as [0, 1, 2, 3, 8, 10, 11]; what Linux writes for a set of CPUs. */
export function parseCpuList(text: string): number[] {
  const out: number[] = [];
  for (const part of text.split(",")) {
    const [from, to = from] = part.trim().split("-");
    const first = Number(from);
    const last = Number(to);
    if (from === "" || !Number.isInteger(first) || !Number.isInteger(last)) {
      continue;
    }
    for (let cpu = first; cpu <= last; cpu++) {
      out.push(cpu);
    }
  }
  return out;
}

/**
 * Physical cores of the performance class, on Linux; undefined where that cannot be told (no sysfs,
 * another operating system). `sysDevices` is `/sys/devices`, a parameter so tests can point at a copy.
 *
 * Which CPUs are the big ones comes from, in order:
 * - `cpu_core/cpus`, which Intel's hybrid processors list the P-cores in. `cpu_capacity` is no help
 *   there: the kernel reports 1024 for P and E cores alike.
 * - `cpu_capacity` where it differs between CPUs (Arm, RISC-V): those within 3/4 of the largest.
 * - otherwise all of them: the processor is not hybrid.
 * A core's hyperthreads are the CPUs sharing a `thread_siblings_list`; a core is counted once.
 */
export function performanceCores(sysDevices = "/sys/devices"): number | undefined {
  const cpuDir = join(sysDevices, "system", "cpu");
  const onlineText = read(join(cpuDir, "online"));
  let online: number[];
  if (onlineText !== undefined) {
    online = parseCpuList(onlineText);
  } else {
    try {
      online = readdirSync(cpuDir)
        .map((name) => /^cpu(\d+)$/.exec(name)?.[1])
        .filter((n) => n !== undefined)
        .map(Number);
    } catch {
      return undefined;
    }
  }
  if (online.length === 0) {
    return undefined;
  }

  let big = online;
  const pCores = read(join(sysDevices, "cpu_core", "cpus"));
  if (pCores !== undefined) {
    const set = new Set(parseCpuList(pCores));
    big = online.filter((cpu) => set.has(cpu));
  } else {
    const capacity = new Map<number, number>();
    for (const cpu of online) {
      const value = Number(read(join(cpuDir, `cpu${cpu}`, "cpu_capacity")));
      if (Number.isFinite(value) && value > 0) {
        capacity.set(cpu, value);
      }
    }
    const largest = Math.max(0, ...capacity.values());
    const smallest = Math.min(Infinity, ...capacity.values());
    if (capacity.size === online.length && smallest < largest) {
      big = online.filter((cpu) => capacity.get(cpu)! >= largest * BIG_CAPACITY);
    }
  }
  if (big.length === 0) {
    return undefined;
  }

  const cores = new Set(
    big.map((cpu) => read(join(cpuDir, `cpu${cpu}`, "topology", "thread_siblings_list")) ?? `cpu${cpu}`),
  );
  return cores.size;
}

/**
 * Threads for inference: the performance cores, but never more than the CPUs this process may use
 * (`logical`: a container, a CPU quota or an affinity mask can allow fewer than the machine has) or
 * eight. Without knowing the cores it assumes two CPUs per core.
 */
export function autoThreads(performance: number | undefined, logical: number): number {
  const cores = performance ?? Math.floor(logical / 2);
  return Math.max(1, Math.min(cores, logical, MAX_AUTO_THREADS));
}

let detected: { value: number | undefined } | undefined;

/** `configured` threads, or when that is 0 the automatic count. Detection runs once. */
export function inferenceThreads(configured: number): number {
  if (configured > 0) {
    return configured;
  }
  detected ??= { value: performanceCores() };
  return autoThreads(detected.value, navigator.hardwareConcurrency);
}
