// Quality of service on Windows. Windows 11 places a thread on a performance or an efficiency core by
// its QoS, which it infers from the process's windows; the server has none of its own (a console, or
// none at all), so its engine threads can end up on E-cores while the user waits on the page, and
// llama.cpp waits for its slowest thread (src/cpu.ts). While a page on this machine is shown
// (`GET /health?visible=true` from loopback), the process opts out of execution-speed throttling,
// which is HighQoS; once no page has said so for QOS_LEASE_MS, Windows decides again.

import { dlopen } from "bun:ffi";

/** How long one `visible=true` holds HighQoS: three of the page's 5 s polls, so one lost poll changes nothing. */
export const QOS_LEASE_MS = 15_000;

/** `true`: ask for HighQoS; `false`: leave it to the system. Throws when the system refuses. */
export type QosSetter = (high: boolean) => void;

// processthreadsapi.h
const PROCESS_POWER_THROTTLING = 4; // PROCESS_INFORMATION_CLASS ProcessPowerThrottling
const PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1;
const PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1;

/**
 * `SetProcessInformation(ProcessPowerThrottling)` from kernel32 on Windows; undefined elsewhere. The
 * control mask with an empty state mask turns throttling off (HighQoS); both empty hand it back to the
 * system. Windows before 10 1709 has no such class and refuses it.
 */
export function windowsQos(): QosSetter | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  const { symbols } = dlopen("kernel32.dll", {
    // A HANDLE as a 64-bit integer: the current process is the pseudo-handle -1, which a bun:ffi pointer cannot hold.
    GetCurrentProcess: { args: [], returns: "i64" },
    SetProcessInformation: { args: ["i64", "i32", "ptr", "u32"], returns: "i32" },
  });
  const self = symbols.GetCurrentProcess();
  return (high) => {
    // PROCESS_POWER_THROTTLING_STATE { ULONG Version; ULONG ControlMask; ULONG StateMask; }
    const state = new Uint32Array([
      PROCESS_POWER_THROTTLING_CURRENT_VERSION,
      high ? PROCESS_POWER_THROTTLING_EXECUTION_SPEED : 0,
      0,
    ]);
    if (symbols.SetProcessInformation(self, PROCESS_POWER_THROTTLING, state, state.byteLength) === 0) {
      throw new Error("SetProcessInformation(ProcessPowerThrottling) failed");
    }
  };
}

export interface QosLease {
  /** A page is shown: HighQoS from now until `ttlMs` after the last renewal. */
  renew(): void;
  /** Whether HighQoS is held now. */
  readonly held: boolean;
  /** Hands QoS back to the system at once (server shutdown). */
  stop(): void;
}

/**
 * HighQoS held by renewals. `set` undefined (not Windows) makes every call a no-op; a `set` that throws
 * is logged once and not called again.
 */
export function createQosLease(set: QosSetter | undefined, ttlMs = QOS_LEASE_MS): QosLease {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let held = false;

  function apply(high: boolean): boolean {
    if (!set) {
      return false;
    }
    try {
      set(high);
      return true;
    } catch (e) {
      console.error(
        `[qos] cannot set the quality of service, not trying again: ${e instanceof Error ? e.message : String(e)}`,
      );
      set = undefined;
      return false;
    }
  }

  function release() {
    clearTimeout(timer);
    timer = undefined;
    if (held) {
      held = false;
      apply(false);
    }
  }

  return {
    renew() {
      if (!held) {
        held = apply(true);
        if (!held) {
          return;
        }
      }
      clearTimeout(timer);
      // Never what keeps the process alive.
      timer = setTimeout(release, ttlMs).unref();
    },
    get held() {
      return held;
    },
    stop: release,
  };
}

/** Whether `address` (from `server.requestIP`) is this machine: 127.0.0.0/8, ::1, or IPv4 loopback mapped into IPv6. */
export function isLoopback(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  const v4 = address.toLowerCase().replace(/^::ffff:/, "");
  return address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}
