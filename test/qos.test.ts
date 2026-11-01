// The HighQoS lease and its loopback check (src/qos.ts) with a recording setter; the Windows call itself
// is tried only where it exists.

import { describe, expect, jest, spyOn, test } from "bun:test";

import { type App, startApp } from "../src/app";
import { createQosLease, isLoopback, QOS_LEASE_MS, windowsQos } from "../src/qos";
import { config, errorOf, launcher, waitReady } from "./helpers/mock-engine";

describe("createQosLease", () => {
  test("asks once, keeps it while renewed, and hands it back after the lease", () => {
    jest.useFakeTimers();
    try {
      const calls: boolean[] = [];
      const lease = createQosLease((high) => void calls.push(high));
      lease.renew();
      lease.renew();
      expect(calls).toStrictEqual([true]);
      expect(lease.held).toBe(true);
      jest.advanceTimersByTime(QOS_LEASE_MS - 1);
      lease.renew();
      jest.advanceTimersByTime(QOS_LEASE_MS - 1);
      // Almost two leases after the first renewal, under one after the last: still held.
      expect(lease.held).toBe(true);
      jest.advanceTimersByTime(1);
      expect(lease.held).toBe(false);
      expect(calls).toStrictEqual([true, false]);

      lease.renew();
      lease.stop();
      expect(calls).toStrictEqual([true, false, true, false]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("without a setter nothing is held", () => {
    const lease = createQosLease(undefined);
    lease.renew();
    expect(lease.held).toBe(false);
    lease.stop();
  });

  test("a setter that fails is logged once and not called again", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      let calls = 0;
      const lease = createQosLease(() => {
        calls++;
        throw new Error("refused");
      });
      lease.renew();
      lease.renew();
      expect(lease.held).toBe(false);
      expect(calls).toBe(1);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });
});

test("isLoopback", () => {
  for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1"]) {
    expect(isLoopback(address)).toBe(true);
  }
  for (const address of [undefined, "", "10.0.0.1", "128.0.0.1", "::2", "::ffff:10.0.0.1", "fe80::1", "127.0.0.1.5"]) {
    expect(isLoopback(address)).toBe(false);
  }
});

test.skipIf(process.platform !== "win32")("the Windows setter is accepted both ways", () => {
  const set = windowsQos()!;
  expect(() => set(true)).not.toThrow();
  expect(() => set(false)).not.toThrow();
});

test.skipIf(process.platform === "win32")("there is no setter outside Windows", () => {
  expect(windowsQos()).toBeUndefined();
});

describe("GET /health?visible", () => {
  test("true from loopback renews the lease, false and nothing do not, anything else is a 400", async () => {
    const calls: boolean[] = [];
    let app: App | undefined;
    try {
      app = await startApp(config(), launcher, undefined, undefined, undefined, (high) => void calls.push(high));
      await waitReady(app);
      const base = app.server.url.origin + "/api/v1/health";

      for (const query of ["", "?visible=false"]) {
        const res = await fetch(base + query);
        expect(res.status).toBe(200);
        await res.text();
      }
      expect(calls).toStrictEqual([]);

      const bad = await fetch(base + "?visible=yes");
      expect(bad.status).toBe(400);
      await expect(errorOf(bad)).resolves.toMatchObject({ code: "invalid_request", details: { field: "visible" } });

      const res = await fetch(base + "?visible=true");
      expect(res.status).toBe(200);
      await res.text();
      expect(calls).toStrictEqual([true]);
    } finally {
      await app?.stop();
    }
    // Stopping the server hands QoS back.
    expect(calls).toStrictEqual([true, false]);
  });
});
