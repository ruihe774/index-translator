import { describe, expect, test } from "bun:test";

import { hostAllowed, originAllowed, parseHostRule, parseOriginRule } from "../src/access";
import { loadConfig } from "../src/config";

const hosts = (...entries: string[]) => entries.map(parseHostRule);
const origins = (...entries: string[]) => entries.map(parseOriginRule);

describe("ALLOWED_HOSTS patterns", () => {
  test("a name matches any port, in any case", () => {
    const r = hosts("Translate.Example.com");
    expect(hostAllowed(r, "translate.example.com")).toBe(true);
    expect(hostAllowed(r, "TRANSLATE.example.com:8443")).toBe(true);
    expect(hostAllowed(r, "other.example.com")).toBe(false);
    expect(hostAllowed(r, "translate.example.com.evil.net")).toBe(false);
  });

  test("name:port matches that port only", () => {
    const r = hosts("example.com:8080");
    expect(hostAllowed(r, "example.com:8080")).toBe(true);
    expect(hostAllowed(r, "example.com:9090")).toBe(false);
    expect(hostAllowed(r, "example.com")).toBe(false);
  });

  test("*.name matches subdomains at any depth, not the name itself or a lookalike", () => {
    const r = hosts("*.example.com");
    expect(hostAllowed(r, "a.example.com")).toBe(true);
    expect(hostAllowed(r, "a.b.example.com:3000")).toBe(true);
    expect(hostAllowed(r, "example.com")).toBe(false);
    expect(hostAllowed(r, "badexample.com")).toBe(false);
    expect(hostAllowed(r, ".example.com")).toBe(false);
    expect(hostAllowed(hosts("*.example.com:8080"), "a.example.com:3000")).toBe(false);
  });

  test("IP addresses, bracketed or not, and a malformed header", () => {
    expect(hostAllowed(hosts("192.168.1.5"), "192.168.1.5:3000")).toBe(true);
    expect(hostAllowed(hosts("::1"), "[::1]:3000")).toBe(true);
    expect(hostAllowed(hosts("[fd00::2]:3000"), "[fd00::2]:3000")).toBe(true);
    expect(hostAllowed(hosts("example.com"), "")).toBe(false);
    expect(hostAllowed(hosts("example.com"), "exa mple.com")).toBe(false);
  });

  test("entries that could never match are refused", () => {
    for (const bad of [
      "*",
      "https://example.com",
      "example.com/x",
      "a*.example.com",
      "*.",
      "*.192.168.0.1",
      "x:99999",
    ]) {
      expect(() => parseHostRule(bad)).toThrow(/ALLOWED_HOSTS/);
    }
  });
});

describe("ALLOWED_ORIGINS patterns", () => {
  test("scheme, host and port must all match; a trailing slash and case are ignored", () => {
    const r = origins("https://App.example.com/", "http://localhost:5173");
    expect(originAllowed(r, "https://app.example.com")).toBe(true);
    expect(originAllowed(r, "http://localhost:5173")).toBe(true);
    expect(originAllowed(r, "http://app.example.com")).toBe(false);
    expect(originAllowed(r, "https://app.example.com:8443")).toBe(false);
    expect(originAllowed(r, "http://localhost:5174")).toBe(false);
    expect(originAllowed(r, "null")).toBe(false);
  });

  test("the default port is the same as none", () => {
    expect(originAllowed(origins("https://a.example:443"), "https://a.example")).toBe(true);
    expect(originAllowed(origins("https://a.example"), "https://a.example:443")).toBe(true);
    expect(originAllowed(origins("http://a.example:80"), "http://a.example")).toBe(true);
  });

  test("https://*.name matches subdomains on the stated scheme and port", () => {
    const r = origins("https://*.example.com", "http://*.dev.example:5173");
    expect(originAllowed(r, "https://a.example.com")).toBe(true);
    expect(originAllowed(r, "https://a.b.example.com")).toBe(true);
    expect(originAllowed(r, "https://example.com")).toBe(false);
    expect(originAllowed(r, "http://a.example.com")).toBe(false);
    expect(originAllowed(r, "https://a.example.com:8443")).toBe(false);
    expect(originAllowed(r, "https://evil.com/.example.com")).toBe(false);
    expect(originAllowed(r, "http://x.dev.example:5173")).toBe(true);
  });

  test("entries that could never match are refused", () => {
    for (const bad of [
      "*",
      "app.example.com",
      "ftp://a.example",
      "https://a.example/app",
      "https://a.example?x=1",
      "https://*.192.168.0.1",
      "https://a*.example.com",
    ]) {
      expect(() => parseOriginRule(bad)).toThrow(/ALLOWED_ORIGINS/);
    }
  });
});

describe("loadConfig validates the lists", () => {
  test("a bad entry stops startup, with the setting named", () => {
    expect(() => loadConfig({ ALLOWED_HOSTS: "*" }, [])).toThrow(/ALLOWED_HOSTS/);
    expect(() => loadConfig({}, ["--allowed-origins", "*"])).toThrow(/ALLOWED_ORIGINS/);
  });

  test("patterns pass through unchanged", () => {
    const cfg = loadConfig({ ALLOWED_HOSTS: "*.example.com, a:80", ALLOWED_ORIGINS: "https://*.example.com" }, []);
    expect(cfg.allowedHosts).toEqual(["*.example.com", "a:80"]);
    expect(cfg.allowedOrigins).toEqual(["https://*.example.com"]);
  });
});
