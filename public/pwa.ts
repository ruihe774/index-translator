// Registers the service worker (public/sw.ts), which makes the installed app open from its cache.

/** Not in development, where DEV_RELOAD serves a changing page that a cache would hide. */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    return;
  }
  if (document.querySelector('script[src^="/__dev/"]')) {
    return;
  }
  navigator.serviceWorker.register("/sw.ts", { scope: "/" }).catch(() => {
    // The app works without it; there is nothing to tell the user.
  });
}
