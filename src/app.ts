// HTTP surface: REST + SSE API under /api/v1 and static files for the web app. The routes are one
// table below; what they do lives in the modules they call (translate.ts, jobs.ts, parse.ts, health.ts, ...).

import type { Server } from "bun";

import {
  domainAllowed,
  type DomainRule,
  hostAllowed,
  type HostRule,
  originAllowed,
  type OriginRule,
  parseDomainRule,
  parseHostRule,
  parseOriginRule,
} from "./access";
import type { Alignment, Language, Segmentation, Voice, VoiceList, Webpage } from "./api";
import type { Config } from "./config";
import { createDevReload, DEV_PREFIX } from "./dev-reload";
import { createStatus } from "./health";
import { ApiError, cancelled, errorResponse, invalid, json, methodNotAllowed } from "./http";
import { prepareImage } from "./image";
import { createJobs } from "./jobs";
import { Engine, type Launcher, launchNative } from "./llama";
import { findModel } from "./models";
import {
  MAX_BODY_BYTES,
  mediaType,
  parseAlignRequest,
  parseBody,
  parseSegmentRequest,
  parseSpeechRequest,
  parseTranslateRequest,
  parseWebpageUrl,
  present,
  speechUnavailable,
} from "./parse";
import { LANGUAGES } from "./prompt";
import { watchPublic } from "./public-watch";
import { nativeSegmenter, type Segmenter, type SegmentLauncher } from "./segment";
import {
  MAX_SAMPLE_BYTES,
  MAX_SAMPLE_SECONDS,
  MAX_SPEECH_CHARS,
  MAX_SPEED,
  MAX_UPLOADED_VOICES,
  MAX_VOICE_NAME_CHARS,
  MIN_SAMPLE_SECONDS,
  MIN_SPEED,
  nativeSpeech,
  SAMPLE_RATE,
  SeparationError,
  type Speech,
  SPEECH_LANGUAGES,
  SpeechError,
  type SpeechLauncher,
  type SpeechRequest,
} from "./speech";
import { createSpeechResponder } from "./speech-response";
import { createStaticServer } from "./static";
import { enterLine, makeLine, withTicket } from "./tickets";
import { createTranslator } from "./translate";
import {
  limitFetches,
  type WebpageFetcher,
  WebpageForbiddenError,
  WebpageUnavailableError,
  webViewFetcher,
} from "./webpage";

const API = "/api/v1";
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/** What `checkHost`, `checkOrigin` and `POST /webpage` compare against, parsed once; an invalid entry throws here. */
interface Access {
  hosts: HostRule[];
  origins: OriginRule[];
  webpages: DomainRule[];
}

function compileAccess(cfg: Config): Access {
  const exact = (name: string): HostRule => ({ name, wildcard: false, port: undefined });
  const own = cfg.host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return {
    hosts: [...LOOPBACK_HOSTS, own].map(exact).concat(cfg.allowedHosts.map(parseHostRule)),
    origins: cfg.allowedOrigins.map(parseOriginRule),
    webpages: cfg.allowedWebpageDomains.map(parseDomainRule),
  };
}

/** Anti DNS-rebinding: a rebinding page reaches us under its own host name. */
function checkHost(req: Request, access: Access): void {
  if (!hostAllowed(access.hosts, req.headers.get("host") ?? "")) {
    throw new ApiError(403, "forbidden_host", "this Host header is not allowed; add the host name to ALLOWED_HOSTS");
  }
}

/** A request without an Origin header is not from a browser page and is allowed. */
function checkOrigin(req: Request, access: Access): void {
  const origin = req.headers.get("origin");
  if (origin === null) {
    return;
  }
  const host = (req.headers.get("host") ?? "").toLowerCase();
  let sameOrigin = false;
  try {
    sameOrigin = new URL(origin).host === host;
  } catch {
    // "null" and other non-URL origins are never same-origin
  }
  if (!sameOrigin && !originAllowed(access.origins, origin)) {
    throw new ApiError(
      403,
      "forbidden_origin",
      "cross-origin requests are not allowed; add the origin to ALLOWED_ORIGINS",
    );
  }
}

interface RouteContext {
  req: Request;
  url: URL;
}
type Handler = (ctx: RouteContext) => Response | Promise<Response>;
/** `noTimeout`: the request may stay silent longer than Bun's idle timeout (a model load, a long generation). */
type Entry = Handler | { handler: Handler; noTimeout: true };
/** The methods a path answers; any other is `405` with `Allow` listing these keys. */
type Route = Partial<Record<"GET" | "POST", Entry>>;

export interface App {
  server: Server<undefined>;
  engine: Engine;
  speech: Speech;
  segmenter: Segmenter;
  stop(): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/require-await -- a bad config rejects here, where callers await it, instead of throwing
export async function startApp(
  cfg: Config,
  launch: Launcher = launchNative,
  launchSpeech: SpeechLauncher = nativeSpeech,
  fetchPageUnlimited: WebpageFetcher = webViewFetcher(),
  launchSegmenter: SegmentLauncher = nativeSegmenter,
): Promise<App> {
  const access = compileAccess(cfg);
  const engine = new Engine(cfg, launch);
  const speech = launchSpeech(cfg);
  const segmenter = launchSegmenter(cfg);
  const fetchPage = limitFetches(fetchPageUnlimited);
  // Each engine runs on its own thread and has its own line: speech does not hold the translation
  // engine, and segmentation (with alignment, on the same thread) neither.
  const lines = {
    translations: makeLine("translations", cfg.maxQueue),
    speech: makeLine("speech requests", cfg.maxQueue),
    segment: makeLine("segmentations and alignments", cfg.maxQueue),
  };
  const defaultModel = findModel(cfg.defaultModel)!;
  const translator = createTranslator(cfg, engine, lines.translations);
  const jobs = createJobs();
  const speechResponse = createSpeechResponder(cfg);

  // Load the default model before the first request arrives; requests that come earlier wait in line.
  void withTicket(lines.translations, new AbortController().signal, () => engine.load(defaultModel)).catch(() => {
    // already logged by the engine; the next request retries the load
  });

  /** Why `POST /webpage` cannot be used, or undefined when it can be tried. */
  async function webpageProblem(): Promise<string | undefined> {
    if (access.webpages.length === 0) {
      return "no domains are allowed; list them in ALLOWED_WEBPAGE_DOMAINS";
    }
    return fetchPage.problem();
  }

  const status = createStatus({ cfg, engine, speech, segmenter, queue: lines.translations.queue, webpageProblem });

  async function uploadVoice(req: Request, url: URL): Promise<Response> {
    if (speech.state === "unavailable") {
      throw speechUnavailable(speech);
    }
    if (mediaType(req) !== "audio/wav") {
      throw new ApiError(415, "unsupported_media_type", "request body must be audio/wav");
    }
    const declared = Number(req.headers.get("content-length"));
    if (declared > MAX_SAMPLE_BYTES) {
      throw new ApiError(413, "body_too_large", "the sample is too large");
    }
    const wav = await req.arrayBuffer();
    if (wav.byteLength === 0) {
      throw invalid("the body must be a WAV recording", "body");
    }
    if (wav.byteLength > MAX_SAMPLE_BYTES) {
      throw new ApiError(413, "body_too_large", "the sample is too large");
    }
    const name =
      (url.searchParams.get("name") ?? "").replaceAll(/\s+/g, " ").trim().slice(0, MAX_VOICE_NAME_CHARS) ||
      "Uploaded voice";
    try {
      return json<Voice>(await speech.addVoice(name, wav), 201);
    } catch (e) {
      // Not the client's doing: the sample was fine, the engine could not separate it. Mapped by toApiError.
      if (e instanceof SpeechError && !(e instanceof SeparationError)) {
        throw invalid(e.message, "body");
      }
      throw e;
    }
  }

  function speak(input: SpeechRequest, req: Request): Promise<Response> {
    return withTicket(lines.speech, req.signal, async (held) => {
      // Once the utterance is handed to the engine the slot is kept until the engine's `done`: the
      // engine stops an abandoned utterance within one step of the model, and the next one must not
      // be started beside it.
      held.keep();
      const wav = await speech.synthesize(input, req.signal, () => held.ticket.leave());
      return speechResponse(wav, req.headers.get("accept"));
    });
  }

  async function fetchWebpage(body: Record<string, unknown>, signal: AbortSignal): Promise<Webpage> {
    const url = parseWebpageUrl(body);
    const problem = await webpageProblem();
    if (problem) {
      throw new WebpageUnavailableError(problem);
    }
    const allowed = (u: URL) =>
      (u.protocol === "http:" || u.protocol === "https:") && domainAllowed(access.webpages, u);
    if (!allowed(url)) {
      throw new WebpageForbiddenError(`${url.hostname} is not in ALLOWED_WEBPAGE_DOMAINS`);
    }
    try {
      return await fetchPage.fetch(url, allowed, signal);
    } catch (e) {
      throw signal.aborted ? cancelled() : e;
    }
  }

  const routes: Record<string, Route> = {
    "/health": { GET: () => status.health() },
    "/models": { GET: () => status.models() },
    "/languages": {
      GET: () => json<{ languages: Language[] }>({ languages: LANGUAGES.map(({ code, name }) => ({ code, name })) }),
    },
    "/voices": {
      GET: async () =>
        json<VoiceList>({
          status: speech.state,
          error: speech.error,
          languages: SPEECH_LANGUAGES,
          speed: { min: MIN_SPEED, max: MAX_SPEED },
          max_chars: MAX_SPEECH_CHARS,
          max_voices: MAX_UPLOADED_VOICES,
          max_name_chars: MAX_VOICE_NAME_CHARS,
          max_sample_bytes: MAX_SAMPLE_BYTES,
          sample_seconds: { min: MIN_SAMPLE_SECONDS, max: MAX_SAMPLE_SECONDS },
          sample_rate: { min: SAMPLE_RATE, max: SAMPLE_RATE },
          voices: speech.state === "unavailable" ? [] : await speech.voices(),
        }),
      POST: ({ req, url }) => uploadVoice(req, url),
    },
    "/speech": {
      // The first request starts the engine and loads the model.
      POST: {
        noTimeout: true,
        handler: async ({ req }) => speak(await parseSpeechRequest(await parseBody(req), speech, cfg.voicesDir), req),
      },
    },
    "/segment": {
      // The first request loads the model.
      POST: {
        noTimeout: true,
        handler: async ({ req }) => {
          const texts = parseSegmentRequest(await parseBody(req), segmenter);
          return json<Segmentation>(
            await withTicket(lines.segment, req.signal, async () => ({
              texts: await segmenter.segment(texts, req.signal),
            })),
          );
        },
      },
    },
    "/align": {
      // The first request loads the model.
      POST: {
        noTimeout: true,
        handler: async ({ req }) => {
          const { unit, source, target } = parseAlignRequest(await parseBody(req), segmenter);
          return json<Alignment>(
            await withTicket(lines.segment, req.signal, async () => ({
              pairs: await segmenter.align(unit, source, target, req.signal),
            })),
          );
        },
      },
    },
    "/webpage": {
      // Opening a page may take up to its own limit (src/webpage.ts), beyond Bun's idle timeout.
      POST: {
        noTimeout: true,
        handler: async ({ req }) => json<Webpage>(await fetchWebpage(await parseBody(req), req.signal)),
      },
    },
    "/openapi.yaml": {
      GET: () => new Response(Bun.file(cfg.specPath), { headers: { "content-type": "application/yaml" } }),
    },
    "/tokenize": {
      POST: async ({ req }) => {
        const body = await parseBody(req);
        // Counting an image means preparing it on the engine thread, which would have to wait for the queue.
        if (present(body.image)) {
          throw invalid("image is not supported by /tokenize", "image");
        }
        return json(await translator.tokenize(parseTranslateRequest(body, cfg.defaultModel)));
      },
    },
    "/translate": {
      // A long translation can stay silent for minutes in JSON mode, and a model swap can take a while.
      POST: {
        noTimeout: true,
        handler: async ({ req }) => {
          const input = parseTranslateRequest(await parseBody(req, true), cfg.defaultModel);
          // Before the queue: an upload that is not a usable image is refused like any other bad field.
          if (input.image) {
            input.image = await prepareImage(input.image);
          }
          return input.stream
            ? jobs.startJob(
                input.resumable,
                (onPosition) => enterLine(lines.translations, onPosition),
                (ticket, signal) => translator.run(input, ticket, signal),
                req.signal,
              )
            : translator.translateJson(input, req.signal);
        },
      },
    },
  };

  async function route(req: Request, url: URL, server: Server<undefined>): Promise<Response> {
    checkHost(req, access);
    checkOrigin(req, access);
    const rest = url.pathname.slice(API.length);
    const methods = routes[rest];
    if (!methods) {
      const res = jobs.translationRoute(rest, req, url);
      if (res) {
        return res;
      }
      throw new ApiError(404, "not_found", `no such endpoint: ${url.pathname}`);
    }
    const entry = (methods as Record<string, Entry | undefined>)[req.method];
    if (!entry) {
      return methodNotAllowed(Object.keys(methods).join(", "));
    }
    if (typeof entry === "function") {
      return entry({ req, url });
    }
    server.timeout(req, 0);
    return entry.handler({ req, url });
  }

  const publicWatcher = watchPublic(cfg.publicDir);
  const serveStatic = createStaticServer(cfg.publicDir, publicWatcher);
  const devReload = cfg.devReload ? createDevReload(publicWatcher) : undefined;

  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    // Hard backstop; parseBody rejects anything over MAX_BODY_BYTES with a proper error body first.
    maxRequestBodySize: MAX_BODY_BYTES * 4,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (devReload && path.startsWith(DEV_PREFIX)) {
        const res = devReload.handle(path, req, server);
        if (res) {
          return res;
        }
      }
      if (!path.startsWith(API + "/")) {
        const res = await serveStatic(path, req);
        return devReload ? devReload.inject(res) : res;
      }
      try {
        return await route(req, url, server);
      } catch (e) {
        return errorResponse(e);
      }
    },
    error(e) {
      return errorResponse(e);
    },
  });

  return {
    server,
    engine,
    speech,
    segmenter,
    async stop() {
      devReload?.close();
      publicWatcher.close();
      await server.stop(true);
      await speech.stop();
      await segmenter.stop();
      await engine.unload();
    },
  };
}
