// What the page calls the process that serves it: on a loopback address that is the app on the user's own
// machine, elsewhere it is a server somebody else runs. No `location` (bun test) means "the server".

function onLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

/** "the local server in your computer" on a loopback address, else "the server". */
export function theServer(): string {
  const hostname = (globalThis as { location?: { hostname?: string } }).location?.hostname;
  return hostname !== undefined && onLoopback(hostname) ? "the local server in your computer" : "the server";
}

/** `theServer()` at the start of a sentence. */
export function TheServer(): string {
  const name = theServer();
  return name[0]!.toUpperCase() + name.slice(1);
}
