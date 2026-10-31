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
import { anonymousFile } from "./anonymous-file";
import type {
  Alignment,
  Language,
  Segmentation,
  TranscriptionEvents,
  TranslateEvents,
  Voice,
  VoiceList,
  Webpage,
} from "./api";
import type { Config } from "./config";
import { createDevReload, DEV_PREFIX } from "./dev-reload";
import { soxrDir } from "./ffi-util";
import { createStatus } from "./health";
import { ApiError, cancelled, errorResponse, invalid, json, methodNotAllowed, unavailable } from "./http";
import { prepareImage } from "./image";
import { createJobs, type Emit, emitTranslation, TRANSCRIPTION_JOBS, TRANSLATION_JOBS } from "./jobs";
import { Engine, type Launcher, launchNative } from "./llama";
import { defaultModelSpec } from "./models";
import { uploadTypes } from "./opus-file";
import { OPUS_TYPE } from "./opus-stream";
import {
  MAX_REQUEST_BYTES,
  mediaType,
  parseAlignRequest,
  parseBody,
  parseSegmentRequest,
  parseSeparate,
  parseSpeechRequest,
  parseTranslateRequest,
  parseWebpageUrl,
  present,
  readBody,
  speechUnavailable,
} from "./parse";
import { LANGUAGES } from "./prompt";
import { watchPublic } from "./public-watch";
import type { Ticket } from "./queue";
import { soxrResampler } from "./resample";
import { nativeSegmenter, type Segmenter, type SegmentLauncher } from "./segment";
import {
  MAX_SAMPLE_BYTES,
  MAX_SAMPLE_SECONDS,
  MAX_SPEECH_CHARS,
  MAX_SPEED,
  MAX_TRANSCRIBE_BYTES,
  MAX_UPLOADED_VOICES,
  MAX_VOICE_NAME_CHARS,
  MIN_SAMPLE_SECONDS,
  MIN_SPEED,
  nativeSpeech,
  opusSampleToWav,
  SAMPLE_RATE,
  type SeparateMode,
  SeparationError,
  type Speech,
  SPEECH_LANGUAGES,
  SpeechError,
  type SpeechLauncher,
  type SpeechRequest,
  validateRecording,
} from "./speech";
import { createSpeechResponder } from "./speech-response";
import { createStaticServer } from "./static";
import { enterLine, granted, makeLine, withTicket } from "./tickets";
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
  const defaultModel = defaultModelSpec(cfg);
  const translator = createTranslator(cfg, engine, lines.translations);
  const jobs = createJobs<TranslateEvents>(TRANSLATION_JOBS);
  const transcriptions = createJobs<TranscriptionEvents>(TRANSCRIPTION_JOBS);
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

  /** Resamples an Ogg Opus voice sample, which is decoded at 48 kHz, to the rate the separator takes. */
  const resample = soxrResampler(soxrDir(cfg.audioDir));

  /** The media type of an upload, which must be one of `uploadTypes` (Ogg Opus only with libopus installed). */
  function uploadType(req: Request): string {
    const types = uploadTypes(cfg.audioDir);
    const type = mediaType(req);
    if (!types.includes(type)) {
      throw new ApiError(415, "unsupported_media_type", `request body must be ${types.join(" or ")}`);
    }
    return type;
  }

  async function uploadVoice(req: Request, url: URL): Promise<Response> {
    if (speech.state === "unavailable") {
      throw speechUnavailable(speech);
    }
    const type = uploadType(req);
    const body = await readBody(
      req,
      MAX_SAMPLE_BYTES,
      () => new ApiError(413, "body_too_large", "the sample is too large"),
    );
    if (body.length === 0) {
      throw invalid("the body must be a WAV or Ogg Opus recording", "body");
    }
    const name =
      (url.searchParams.get("name") ?? "").replaceAll(/\s+/g, " ").trim().slice(0, MAX_VOICE_NAME_CHARS) ||
      "Uploaded voice";
    try {
      // Kept and separated as WAV, whatever it was uploaded as.
      const wav = type === OPUS_TYPE ? opusSampleToWav(body, cfg.audioDir, resample) : body.buffer;
      return json<Voice>(await speech.addVoice(name, wav), 201);
    } catch (e) {
      // Not the client's doing: the sample was fine, the engine could not separate it. Mapped by toApiError.
      if (e instanceof SpeechError && !(e instanceof SeparationError)) {
        throw invalid(e.message, "body");
      }
      throw e;
    }
  }

  /** `DELETE /voices/{id}`: forgets an uploaded voice (not an installed one). */
  async function deleteVoice(id: string): Promise<Response> {
    if (!(await speech.removeVoice(id))) {
      throw new ApiError(404, "not_found", "no such uploaded voice");
    }
    return new Response(null, { status: 204 });
  }

  /**
   * `POST /transcriptions`: checks the recording before anything is queued, then runs it as a job in
   * the speech line, which it holds until it ends.
   */
  async function startTranscription(req: Request, url: URL): Promise<Response> {
    const problem = speech.transcribeProblem();
    if (problem) {
      throw unavailable("transcribe_unavailable", problem);
    }
    const type = uploadType(req);
    const separate = parseSeparate(url.searchParams.get("separate"), speech.canSeparate());
    const recording = await readBody(
      req,
      MAX_TRANSCRIBE_BYTES,
      () => new ApiError(413, "body_too_large", "the recording is too large"),
    );
    if (recording.length === 0) {
      throw invalid("the body must be a WAV or Ogg Opus recording", "body");
    }
    let duration: number;
    try {
      duration = validateRecording(recording, type);
    } catch (e) {
      throw e instanceof SpeechError ? invalid(e.message, "body") : e;
    }
    // A waiting transcription holds only a descriptor: a full line of uploads in memory would be gigabytes.
    const file = await anonymousFile(recording);
    try {
      return transcriptions.startJob(
        true,
        (onPosition) => enterLine(lines.speech, onPosition),
        async (ticket, signal, emit) => {
          try {
            await runTranscription({ fd: file.fd, separate, duration }, ticket, signal, emit);
          } finally {
            await file.close();
          }
        },
        req.signal,
      );
    } catch (e) {
      // Refused before it started (a full line): nothing else will close the file.
      await file.close();
      throw e;
    }
  }

  /** One transcription, once it is its turn in the speech line. */
  async function runTranscription(
    job: { fd: number; separate: SeparateMode; duration: number },
    ticket: Ticket,
    signal: AbortSignal,
    emit: Emit<TranscriptionEvents>,
  ): Promise<void> {
    await granted(ticket, signal);
    emit("start", { duration: job.duration });
    // The worker reads no messages while it transcribes: it is stopped through shared memory.
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const stop = () => void Atomics.store(flag, 0, 1);
    signal.addEventListener("abort", stop);
    const speakers = new Set<string>();
    try {
      const done = await speech.transcribe({ fd: job.fd, separate: job.separate }, flag.buffer, (p) => {
        if (p.type === "stage") {
          emit("stage", { stage: p.stage });
        } else {
          speakers.add(p.segment.speaker);
          emit("segment", p.segment);
        }
      });
      if (!done) {
        throw cancelled();
      }
      // Stopped before it wrote a single segment: music or noise it cannot write down, not a recording
      // with nothing said (which finishes, with no segments).
      if (done.truncated && speakers.size === 0) {
        throw new SpeechError(
          `no speech could be written down: the model only repeated itself${done.separated ? "" : " (music? try separate=true)"}`,
        );
      }
      emit("done", {
        duration: done.duration,
        speakers: [...speakers],
        separated: done.separated,
        trimmed: done.trimmed,
        truncated: done.truncated,
      });
    } finally {
      signal.removeEventListener("abort", stop);
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
          upload_types: uploadTypes(cfg.audioDir),
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
    "/transcriptions": {
      // A long recording takes a while to upload and check before the stream starts.
      POST: { noTimeout: true, handler: ({ req, url }) => startTranscription(req, url) },
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
                (ticket, signal, emit) => emitTranslation(translator.run(input, ticket, signal), emit),
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
      const voice = /^\/voices\/([^/]+)$/.exec(rest);
      if (voice) {
        return req.method === "DELETE" ? deleteVoice(voice[1]!) : methodNotAllowed("DELETE");
      }
      const res = jobs.route(rest, req, url) ?? transcriptions.route(rest, req, url);
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
    // Hard backstop; each route rejects what is over its own limit with a proper error body first.
    maxRequestBodySize: MAX_REQUEST_BYTES,
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
