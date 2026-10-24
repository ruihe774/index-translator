// Registers the service worker (public/sw.ts), which makes the installed app open from its cache.

navigator.serviceWorker?.register("/sw.ts", { scope: "/" }).catch(() => {
  // The app works without it; there is nothing to tell the user.
});
