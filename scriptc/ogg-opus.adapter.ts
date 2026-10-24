// What `import ... from "./ogg-opus"` gets when src/ogg-opus.ts is loaded as its compiled module (see
// src/scriptc-plugin.ts): the same exports, over the exports of ogg-opus.entry.ts. It must not import
// src/ogg-opus.ts, which this stands in for.

import { load } from "../src/scriptc-runtime";

interface Wasm {
  lastError(): string;
  muxNew(
    channels: number,
    sampleRate: number,
    preSkip: number,
    serial: number,
    hasVendor: boolean,
    vendor: string,
    maxPageDuration: number,
  ): number;
  muxSerial(mux: number): number;
  muxHeader(mux: number): Uint8Array;
  muxAddPacket(mux: number, data: Uint8Array, duration: number, validDuration: number): Uint8Array;
  muxFinish(mux: number): Uint8Array;
}

const wasm = (await load("ogg-opus")) as unknown as Wasm;

/** Returns what a call returned, or throws the error that it caught. */
function checked(result: Uint8Array): Uint8Array {
  const message = wasm.lastError();
  if (message !== "") {
    throw new Error(message);
  }
  return result;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export class OggOpusMuxer {
  readonly serial: number;
  private readonly id: number;

  constructor(options: {
    channels: 1 | 2;
    sampleRate: number;
    preSkip: number;
    serial?: number;
    vendor?: string;
    maxPageDuration?: number;
  }) {
    this.id = wasm.muxNew(
      options.channels,
      options.sampleRate,
      options.preSkip,
      options.serial ?? Number.NaN,
      options.vendor !== undefined,
      options.vendor ?? "",
      options.maxPageDuration ?? Number.NaN,
    );
    this.serial = wasm.muxSerial(this.id);
  }

  header(): Uint8Array {
    return checked(wasm.muxHeader(this.id));
  }

  addPacket(packet: { data: Uint8Array; duration: number; validDuration: number }): Uint8Array {
    return checked(wasm.muxAddPacket(this.id, packet.data, packet.duration, packet.validDuration));
  }

  finish(): Uint8Array {
    return checked(wasm.muxFinish(this.id));
  }
}
