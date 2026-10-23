// Everything the API tests and the Playwright mock server (e2e/mock-server.ts) use to stand in for the
// engines, in one import: the harness (config, until, waitReady, SSE helpers) and one file per mock
// (mock-llama.ts, mock-speech.ts, mock-webpage.ts, mock-segment.ts). The mocks are module state shared
// by every test file in the run (bun runs them in one process), so a test that changes one restores it,
// or calls resetAllMocks().

import { resetMock, resetMockCounters } from "./mock-llama";
import { resetMockSegment } from "./mock-segment";
import { resetMockSpeech } from "./mock-speech";
import { resetMockWebpage } from "./mock-webpage";

export * from "./harness";
export * from "./mock-llama";
export * from "./mock-segment";
export * from "./mock-speech";
export * from "./mock-webpage";

/** Puts every mock's knobs back to their defaults and forgets what each was asked. */
export function resetAllMocks(): void {
  resetMock();
  resetMockCounters();
  resetMockSpeech();
  resetMockWebpage();
  resetMockSegment();
}
