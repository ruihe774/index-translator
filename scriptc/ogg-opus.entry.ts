// What of src/ogg-opus.ts the WebAssembly build exports. A module's exports cannot be a class, so the
// muxers are numbered here and the adapter (ogg-opus.adapter.ts) makes the class again. An error the
// muxer throws is kept, and the adapter throws it again: an error that left the module would end it.

import { OggOpusMuxer } from "../src/ogg-opus";

const muxers: OggOpusMuxer[] = [];
let failure = "";

/** The message of the error that the last call caught, or "" when it succeeded. */
export function lastError(): string {
  return failure;
}

/** NaN stands for an option that was left out, `hasVendor` for a vendor. */
export function muxNew(
  channels: number,
  sampleRate: number,
  preSkip: number,
  serial: number,
  hasVendor: boolean,
  vendor: string,
  maxPageDuration: number,
): number {
  failure = "";
  muxers.push(
    new OggOpusMuxer({
      channels: channels === 2 ? 2 : 1,
      sampleRate,
      preSkip,
      serial: Number.isNaN(serial) ? undefined : serial,
      vendor: hasVendor ? vendor : undefined,
      maxPageDuration: Number.isNaN(maxPageDuration) ? undefined : maxPageDuration,
    }),
  );
  return muxers.length - 1;
}

export function muxSerial(mux: number): number {
  return muxers[mux]!.serial;
}

export function muxHeader(mux: number): Uint8Array {
  failure = "";
  try {
    return muxers[mux]!.header();
  } catch (e) {
    failure = (e as Error).message;
    return new Uint8Array(0);
  }
}

export function muxAddPacket(mux: number, data: Uint8Array, duration: number, validDuration: number): Uint8Array {
  failure = "";
  try {
    return muxers[mux]!.addPacket({ data, duration, validDuration });
  } catch (e) {
    failure = (e as Error).message;
    return new Uint8Array(0);
  }
}

export function muxFinish(mux: number): Uint8Array {
  failure = "";
  try {
    return muxers[mux]!.finish();
  } catch (e) {
    failure = (e as Error).message;
    return new Uint8Array(0);
  }
}
