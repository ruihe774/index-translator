// Shared fixtures: `mock` scripts the mock engine behind the server, and the page objects below
// keep selectors in one place. Every test starts with the mock reset and a fresh browser context.

import { test as base, expect, type Locator, type Page } from "@playwright/test";

const CONTROL = `http://127.0.0.1:${process.env.E2E_CONTROL_PORT ?? 3101}/mock`;

export interface MockKnobs {
  chunks?: string[];
  delayMs?: number;
  finish?: "stop" | "length";
  failWith?: string | null;
  failLaunch?: string | null;
}

export interface MockState extends Required<Pick<MockKnobs, "chunks" | "delayMs">> {
  requests: { prompt: string; maxTokens: number }[];
  aborted: number;
  launches: string[];
}

export interface Mock {
  set(knobs: MockKnobs): Promise<void>;
  state(): Promise<MockState>;
  /** Unloads the engine; the next translation loads its model again. */
  unload(): Promise<void>;
}

/** The think block a model may put before the answer; the server strips it. */
export const THINK = "<think>\n\n</think>\n\n";

export const CHAT = "index-translate-9b";
export const DOCUMENT = "index-nailong-9b";

export const test = base.extend<{ mock: Mock; app: AppPage }>({
  mock: async ({}, use) => {
    const call = (method: string, body?: unknown, path = ""): Promise<any> =>
      fetch(CONTROL + path, { method, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
    await call("DELETE");
    await use({
      set: async (knobs) => void (await call("POST", { ...knobs, failWith: knobs.failWith ?? undefined, failLaunch: knobs.failLaunch ?? undefined })),
      state: () => call("GET"),
      unload: async () => void (await call("POST", undefined, "/restart")),
    });
    await call("DELETE");
  },
  app: async ({ page, mock }, use) => {
    void mock; // reset before the page loads
    await use(new AppPage(page));
  },
});

export { expect };

export class AppPage {
  readonly from: Locator;
  readonly to: Locator;
  readonly text: Locator;
  readonly translate: Locator;
  readonly stop: Locator;
  readonly copy: Locator;
  readonly engine: Locator;
  readonly selection: Locator;
  readonly progress: Locator;
  readonly error: Locator;
  readonly output: Locator;
  readonly meta: Locator;
  readonly notes: Locator;

  constructor(readonly page: Page) {
    this.from = page.getByLabel("From", { exact: true });
    this.to = page.getByLabel("To", { exact: true });
    this.text = page.getByLabel("Text to translate (required)");
    this.translate = page.getByRole("button", { name: "Translate", exact: true });
    this.stop = page.getByRole("button", { name: "Stop" });
    this.copy = page.getByRole("button", { name: "Copy translation" });
    this.engine = page.locator("#engine");
    this.selection = page.locator("#selection");
    this.progress = page.locator("#progress");
    this.error = page.locator("#error");
    this.output = page.locator("#output");
    this.meta = page.locator("#meta");
    this.notes = page.locator("#notes li");
  }

  /** Opens the page and waits until the language lists are filled. */
  async open() {
    await this.page.goto("/");
    await expect(this.from.locator("option")).not.toHaveCount(0);
    await expect(this.translate).toHaveAttribute("aria-disabled", "false");
  }

  model(name: "Automatic" | "Index-Translate-9B" | "Index-NativeLong-9B") {
    return this.page.getByRole("radio", { name: new RegExp(name) });
  }

  async openAdvanced() {
    await this.page.getByText("Glossary and constraints").click();
  }
}
