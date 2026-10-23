// Shared fixtures: `mock` scripts the mock engine behind the server, and the page objects below
// keep selectors in one place. Every test starts with the mock reset and a fresh browser context.

import { expect, test as base } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { CoverageReport } from "monocart-coverage-reports";

import type { AlignedPair, AlignUnit, FinishReason, SegmentStatus, SpeechStatus, Voice } from "../src/api";
import { COVERAGE, mappedModule, REPORT } from "./coverage";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? PORT + 1);

export interface MockKnobs {
  chunks?: string[];
  delayMs?: number;
  finish?: FinishReason;
  failWith?: string | null;
  failLaunch?: string | null;
  /** The model's image encoder is not installed: an image request fails with this message. */
  imageUnavailable?: string;
  /** The mock speech engine: `state: "unavailable"` is an install without it. */
  speech?: {
    state?: SpeechStatus;
    delayMs?: number;
    audioSeconds?: number;
    failWith?: string;
    voices?: Voice[];
  };
  /**
   * The mock browser of `POST /webpage` (the server allows `example.com` and `*.example.com`):
   * `problem` makes it unavailable, `failWith` fails a fetch, `redirectTo` lands the page elsewhere.
   */
  webpage?: {
    problem?: string;
    title?: string;
    markdown?: string;
    redirectTo?: string;
    delayMs?: number;
    failWith?: string;
  };
  /** The mock sentence model of `POST /segment`: `state: "unavailable"` is an install without it. */
  segment?: { state?: SegmentStatus; delayMs?: number; failWith?: string };
  /**
   * The mock aligner of `POST /align`: item i with item i unless `pairs` says otherwise (what is left
   * over joins the last sentence pair, or stands alone as a paragraph); `state: "unavailable"` is an
   * install without it.
   */
  align?: { state?: SegmentStatus; pairs?: AlignedPair[] };
}

export interface MockState extends Required<Pick<MockKnobs, "chunks" | "delayMs">> {
  /** `image`: the request carried one, which reached the engine with this size, as a PNG or not. */
  requests: { prompt: string; maxTokens: number; image?: { bytes: number; png: boolean } }[];
  aborted: number;
  launches: string[];
  /** `requests` are the utterances asked of the speech engine, in order. */
  speech: { requests: { text: string; lang: string; voice: string; speed: number }[] };
  /** `requests` are the addresses asked of the mock browser, in order. */
  webpage: { requests: string[]; aborted: number };
  /** `requests` are the texts asked of the mock sentence model, one list per request. */
  segment: { requests: string[][]; aborted: number };
  /** `requests` are what was asked of the mock aligner, in order: the unit and both lists. */
  align: { requests: { unit: AlignUnit; source: string[]; target: string[] }[] };
}

export interface Mock {
  set(knobs: MockKnobs): Promise<void>;
  state(): Promise<MockState>;
  /** Unloads the engine; the next translation loads its model again. */
  unload(): Promise<void>;
}

/** The think block a model may put before the answer; the server strips it. */
export const THINK = "<think>\n\n</think>\n\n";

export { CHAT, DOCUMENT } from "../test/helpers/mock-engine";

// Under `E2E_COVERAGE` every page measures its JS; globalTeardown merges the workers' data (`e2e/coverage.ts`).
const coverage = COVERAGE ? new CoverageReport(REPORT) : undefined;

export const test = base.extend<{ mock: Mock; app: AppPage }>({
  page: async ({ page }, use) => {
    if (!coverage) {
      await use(page);
      return;
    }
    // Registered first, so a test's own routes still win.
    await page.route(
      (url) => /\.(ts|js)$/.test(url.pathname) && mappedModule(url.pathname) !== undefined,
      (route) =>
        route.fulfill({
          contentType: "text/javascript; charset=utf-8",
          headers: { "cache-control": "no-store" },
          body: mappedModule(new URL(route.request().url()).pathname),
        }),
    );
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    await coverage.add(await page.coverage.stopJSCoverage());
  },
  // Worker n talks to the n-th server of `e2e/playwright.config.ts` (ports step by 2).
  baseURL: ({}, use, testInfo) => use(`http://127.0.0.1:${PORT + 2 * testInfo.parallelIndex}`),
  mock: async ({}, use, testInfo) => {
    const CONTROL = `http://127.0.0.1:${CONTROL_PORT + 2 * testInfo.parallelIndex}/mock`;
    const call = <T = void>(method: string, body?: unknown, path = ""): Promise<T> =>
      fetch(CONTROL + path, { method, body: body === undefined ? undefined : JSON.stringify(body) }).then(
        (r) => r.json() as Promise<T>,
      );
    await call("DELETE");
    await use({
      set: async (knobs) => {
        await call("POST", {
          ...knobs,
          failWith: knobs.failWith ?? undefined,
          failLaunch: knobs.failLaunch ?? undefined,
        });
      },
      state: () => call<MockState>("GET"),
      unload: () => call("POST", undefined, "/restart"),
    });
    await call("DELETE");
  },
  app: ({ page }, use) => use(new AppPage(page)),
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

  /** Shows the source rendered: it is read aloud only from Preview, not from its text box. */
  async previewSource() {
    await this.page.getByRole("group", { name: "Source view" }).getByRole("button", { name: "Preview" }).click();
  }

  /** The "read from here" buttons beside a side's blocks, shown while its Read aloud is pressed. */
  gutter(side: "source" | "output") {
    return this.page.locator(`#${side}-area .read-from`);
  }

  /** Presses Read aloud, then the read-from button of block `block` (0 is the first). */
  async readAloud(side: "source" | "output", block = 0) {
    await this.page.locator(`#listen-${side}`).click();
    await this.gutter(side).nth(block).click();
  }
}
