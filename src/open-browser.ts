/** Open a URL in the default browser. Failures are logged, never thrown. */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
    void child.exited.then((code) => {
      if (code !== 0) console.error(`[server] could not open browser (${cmd[0]} exited ${code})`);
    });
  } catch (err) {
    console.error(`[server] could not open browser: ${err instanceof Error ? err.message : err}`);
  }
}
