// Web Push (src/push.ts): when the server has it on (`push` in /health), every job the page starts is
// subscribed (`PUT …/push`), and if it ends while the page is away the service worker (sw.ts) shows a
// notification. Permission is asked in the click that starts a job; the browser keeps the answer.

import type { Health } from "../src/api.ts";
import { fromBase64 } from "./base64.ts";

/** The server's VAPID key; undefined while push is off (or /health has not answered). */
let serverKey: string | undefined;
/** The permission prompt opened by the click, if it is still open. */
let asking: Promise<NotificationPermission> | undefined;

export function configurePush(push: Health["push"]): void {
  serverKey = push?.status === "available" ? push.public_key : undefined;
}

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Called in the click that starts a job: browsers ask for permission only from a user gesture. */
export function askForNotifications(): void {
  if (serverKey && supported() && Notification.permission === "default") {
    asking = Notification.requestPermission().catch(() => Notification.permission);
  }
}

function sameBytes(a: ArrayBuffer | null, b: Uint8Array): boolean {
  return a !== null && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);
}

/** Subscribes the job at `jobUrl` (`/api/v1/translations/{id}`) to a notification; nothing happens without one. */
export async function notifyWhenDone(jobUrl: string): Promise<void> {
  if (!serverKey || !supported()) {
    return;
  }
  const key = fromBase64(serverKey, "base64url");
  try {
    // A job accepted while the prompt is still open is subscribed once the user has answered.
    await asking;
    if (Notification.permission !== "granted") {
      return;
    }
    const { pushManager } = await navigator.serviceWorker.ready;
    let subscription = await pushManager.getSubscription();
    // The server makes a new key when it restarts; a subscription made with the old one would be refused.
    if (subscription && !sameBytes(subscription.options.applicationServerKey, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch(`${jobUrl}/push`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription),
    });
  } catch {
    // A browser without a push service (or one that refuses this origin): the job runs as before.
  }
}
