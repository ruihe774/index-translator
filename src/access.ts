/**
 * The patterns of `ALLOWED_HOSTS` and `ALLOWED_ORIGINS`, parsed once at startup.
 *
 * Hosts (the `Host` header, against DNS rebinding): `name`, `*.name`, either with `:port`.
 * Origins (the `Origin` header, against other web pages): `scheme://name[:port]` or `scheme://*.name[:port]`.
 * A bare `*` is refused in both: it would turn the protection off.
 */

const NAME_CHARS = /^[^\s/?#@*\\]+$/;

export interface HostRule {
  /** Lowercase host name without brackets; for a wildcard, the part after `*.`. */
  name: string;
  /** `*.name`: any subdomain of `name`, at any depth, not `name` itself. */
  wildcard: boolean;
  /** Without one, any port matches. */
  port: string | undefined;
}

export interface OriginRule {
  protocol: "http:" | "https:";
  /** Host name as `URL.hostname` gives it; for a wildcard, the part after `*.`. */
  name: string;
  wildcard: boolean;
  /** `URL.port`: empty for the scheme's default port, which is the only one without an explicit port. */
  port: string;
}

function fail(setting: string, entry: string, why: string): never {
  throw new Error(`${setting}: "${entry}" ${why}`);
}

/** The canonical host name of a bare name or IP, brackets removed; undefined when it is not one. */
function canonicalName(name: string): string | undefined {
  try {
    const bracketed = name.includes(":") && !name.startsWith("[") ? `[${name}]` : name;
    return new URL(`http://${bracketed}`).hostname.replace(/^\[(.*)\]$/, "$1");
  } catch {
    return undefined;
  }
}

/** Splits "name", "name:port" or "[v6]:port" (an unbracketed IPv6 address has no port). */
function splitHostPort(value: string): { name: string; port: string | undefined } | undefined {
  if (value.split(":").length > 2 && !value.startsWith("[")) {
    return { name: value, port: undefined };
  }
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(value);
  if (!m) {
    return undefined;
  }
  return { name: m[1] as string, port: m[2] === undefined ? undefined : String(Number(m[2])) };
}

export function parseHostRule(entry: string): HostRule {
  const setting = "ALLOWED_HOSTS";
  const value = entry.trim().toLowerCase();
  if (value === "*") {
    fail(setting, entry, "would allow every host name; list names, or `*.example.com`");
  }
  if (value.includes("://") || value.includes("/")) {
    fail(setting, entry, "must be a host name (`app.example.com`); origins with a scheme go to ALLOWED_ORIGINS");
  }
  const wildcard = value.startsWith("*.");
  const split = splitHostPort(wildcard ? value.slice(2) : value);
  if (!split?.name || !NAME_CHARS.test(split.name)) {
    fail(setting, entry, "is not a host name; use `name`, `name:port` or `*.name`");
  }
  const name = canonicalName(split.name);
  if (!name) {
    fail(setting, entry, "is not a valid host name");
  }
  if (wildcard && (name.includes(":") || /^[\d.]+$/.test(name))) {
    fail(setting, entry, "puts a wildcard on an IP address, which has no subdomains");
  }
  if (split.port !== undefined && Number(split.port) > 65_535) {
    fail(setting, entry, "has a port above 65535");
  }
  return { name, wildcard, port: split.port };
}

export function parseOriginRule(entry: string): OriginRule {
  const setting = "ALLOWED_ORIGINS";
  const value = entry.trim();
  if (value === "*") {
    fail(setting, entry, "would let every web page call the API; list origins, or `https://*.example.com`");
  }
  const m = /^(https?):\/\/(\*\.)?(.+?)\/*$/i.exec(value);
  if (!m) {
    fail(setting, entry, "must be an origin such as `https://app.example.com` or `https://*.example.com`");
  }
  const wildcard = m[2] !== undefined;
  let url: URL;
  try {
    url = new URL(`${(m[1] as string).toLowerCase()}://${m[3]}`);
  } catch {
    fail(setting, entry, "is not a valid origin");
  }
  if (!NAME_CHARS.test(m[3] as string) || url.pathname !== "/" || url.search || url.hash || url.username) {
    fail(setting, entry, "must be scheme, host and port only, without a path");
  }
  const name = url.hostname;
  if (wildcard && (name.startsWith("[") || /^[\d.]+$/.test(name))) {
    fail(setting, entry, "puts a wildcard on an IP address, which has no subdomains");
  }
  return { protocol: url.protocol as OriginRule["protocol"], name, wildcard, port: url.port };
}

function nameMatches(rule: { name: string; wildcard: boolean }, host: string): boolean {
  return rule.wildcard ? host.length > rule.name.length + 1 && host.endsWith(`.${rule.name}`) : host === rule.name;
}

/** Whether the `Host` header value (`name`, `name:port`, `[v6]:port`) is one of `rules`. */
export function hostAllowed(rules: readonly HostRule[], header: string): boolean {
  const split = splitHostPort(header.trim().toLowerCase());
  const host = split && canonicalName(split.name);
  if (!split || !host) {
    return false;
  }
  return rules.some((r) => nameMatches(r, host) && (r.port === undefined || r.port === split.port));
}

/** Whether the `Origin` header value is one of `rules`; "null" and non-web origins never are. */
export function originAllowed(rules: readonly OriginRule[], origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return rules.some((r) => r.protocol === url.protocol && r.port === url.port && nameMatches(r, url.hostname));
}
