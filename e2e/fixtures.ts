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
  /** The mock speech engine: `state: "unavailable"` is an install without it. */
  speech?: { state?: string; delayMs?: number; audioSeconds?: number; failWith?: string };
}

export interface MockState extends Required<Pick<MockKnobs, "chunks" | "delayMs">> {
  requests: { prompt: string; maxTokens: number }[];
  aborted: number;
  launches: string[];
  /** `requests` are the utterances asked of the speech engine, in order. */
  speech: { requests: { text: string; lang: string; voice: string; speed: number }[] };
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
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixture's dependencies from this parameter
  mock: async ({}, use) => {
    const call = (method: string, body?: unknown, path = ""): Promise<any> =>
      fetch(CONTROL + path, { method, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) =>
        r.json(),
      );
    await call("DELETE");
    await use({
      set: async (knobs) =>
        void (await call("POST", {
          ...knobs,
          failWith: knobs.failWith ?? undefined,
          failLaunch: knobs.failLaunch ?? undefined,
        })),
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
  readonly advice: Locator;
  readonly output: Locator;
  readonly meta: Locator;
  readonly notes: Locator;

  constructor(readonly page: Page) {
    this.from = page.getByLabel("From", { exact: true });
    this.to = page.getByLabel("To", { exact: true });
    this.text = page.getByRole("textbox", { name: "Text to translate" });
    this.translate = page.getByRole("button", { name: "Translate", exact: true });
    this.stop = page.getByRole("button", { name: "Stop" });
    this.copy = page.getByRole("button", { name: "Copy translation" });
    this.engine = page.locator("#engine");
    this.advice = page.locator("#advice");
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
    return this.page.getByRole("group", { name: "Model" }).getByRole("button", { name, exact: true });
  }

  async openAdvanced() {
    await this.page.getByText("Glossary and constraints").click();
  }
}
