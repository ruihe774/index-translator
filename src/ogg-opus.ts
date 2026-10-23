// A streaming Ogg Opus muxer (RFC 7845), mono or stereo (channel mapping family 0): ported from
// libopus-wasm's `OggOpusMuxer`, without its encoder. Bun can neither encode nor mux Opus, so this
// wraps the packets of the encoder in src/opus-stream.ts.

/** One Opus packet and how long it plays, as the muxer needs to know it. */
export interface OpusPacket {
  data: Uint8Array;
  /** Samples per channel at 48 kHz that the packet decodes to. */
  duration: number;
  /** `duration` less the silence padded past the end of the stream; only the last packet differs. */
  validDuration: number;
}

interface OggOpusOptions {
  channels: 1 | 2;
  /** The rate of the original audio; informational, stored in OpusHead. */
  sampleRate: number;
  /** The encoder's delay in 48 kHz samples: the decoder drops this many from the start. */
  preSkip: number;
  /** Ogg stream serial number; random by default. */
  serial?: number;
  vendor?: string;
  /** Close a page once it holds this much audio (48 kHz samples); a second by default. */
  maxPageDuration?: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = r & 0x80_00_00_00 ? (r << 1) ^ 0x04_c1_1d_b7 : r << 1;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg's CRC-32: polynomial 0x04c11db7, no reflection, initial value and final xor 0. */
function crc32(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc = ((crc << 8) ^ CRC_TABLE[(crc >>> 24) ^ byte]!) >>> 0;
  }
  return crc;
}

const utf8 = new TextEncoder();

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * `header()` once, `addPacket()` for each packet in order (it returns bytes whenever a page is
 * complete), then `finish()`. Everything returned, in order, is a valid `.opus` file.
 */
export class OggOpusMuxer {
  readonly serial: number;
  private readonly options: OggOpusOptions;
  private readonly maxPage: number;
  private sequence = 0;
  /** 48 kHz samples, pre-skip included, through the last packet queued. */
  private granule = 0;
  private pending: OpusPacket[] = [];
  private pendingDuration = 0;
  private pendingSegments = 0;
  private started = false;
  private done = false;

  constructor(options: OggOpusOptions) {
    this.options = options;
    this.serial = (options.serial ?? Math.random() * 2 ** 32) >>> 0;
    this.maxPage = options.maxPageDuration ?? 48_000;
  }

  /** The two mandatory pages, OpusHead and OpusTags; call first, once. */
  header(): Uint8Array {
    if (this.started) {
      throw new Error("the header is already written");
    }
    this.started = true;
    const { channels, preSkip, sampleRate, vendor } = this.options;

    const head = new Uint8Array(19);
    const headView = new DataView(head.buffer);
    head.set(utf8.encode("OpusHead"));
    head[8] = 1; // version
    head[9] = channels;
    headView.setUint16(10, preSkip, true);
    headView.setUint32(12, sampleRate, true);
    headView.setInt16(16, 0, true); // output gain
    head[18] = 0; // channel mapping family 0

    const name = utf8.encode(vendor ?? "index-translator");
    const tags = new Uint8Array(8 + 4 + name.length + 4);
    const tagsView = new DataView(tags.buffer);
    tags.set(utf8.encode("OpusTags"));
    tagsView.setUint32(8, name.length, true);
    tags.set(name, 12);
    tagsView.setUint32(12 + name.length, 0, true); // no user comments

    return concat([this.page([head], 0, 0x02), this.page([tags], 0, 0)]);
  }

  /** Queues a packet; returns the bytes of the page that it completed, if it did. */
  addPacket(packet: OpusPacket): Uint8Array {
    if (!this.started) {
      throw new Error("call header() first");
    }
    if (this.done) {
      throw new Error("the stream is finished");
    }
    const segments = Math.floor(packet.data.length / 255) + 1;
    // A page holds at most 255 segments: close this one if the packet does not fit.
    let out: Uint8Array = this.pendingSegments + segments > 255 ? this.flush(false) : new Uint8Array(0);
    this.pending.push(packet);
    this.pendingSegments += segments;
    this.pendingDuration += packet.duration;
    this.granule += packet.validDuration;
    if (this.pendingDuration >= this.maxPage) {
      out = concat([out, this.flush(false)]);
    }
    return out;
  }

  /** The last page, with the end-of-stream flag. */
  finish(): Uint8Array {
    if (!this.started) {
      throw new Error("call header() first");
    }
    if (this.done) {
      return new Uint8Array(0);
    }
    this.done = true;
    return this.flush(true);
  }

  private flush(eos: boolean): Uint8Array {
    const packets = this.pending;
    this.pending = [];
    this.pendingDuration = 0;
    this.pendingSegments = 0;
    if (packets.length === 0 && !eos) {
      return new Uint8Array(0);
    }
    // The granule position of a page is the end of its last packet.
    return this.page(
      packets.map((p) => p.data),
      this.granule,
      eos ? 0x04 : 0,
    );
  }

  private page(packets: Uint8Array[], granule: number, flags: number): Uint8Array {
    const lacing: number[] = [];
    let bodyLength = 0;
    for (const packet of packets) {
      let rest = packet.length;
      for (; rest >= 255; rest -= 255) {
        lacing.push(255);
      }
      lacing.push(rest);
      bodyLength += packet.length;
    }
    const page = new Uint8Array(27 + lacing.length + bodyLength);
    const view = new DataView(page.buffer);
    page.set(utf8.encode("OggS"));
    page[4] = 0; // version
    page[5] = flags;
    view.setBigUint64(6, BigInt(granule), true);
    view.setUint32(14, this.serial, true);
    view.setUint32(18, this.sequence++, true);
    // The checksum (at 22) is zero while it is computed.
    page[26] = lacing.length;
    page.set(lacing, 27);
    let at = 27 + lacing.length;
    for (const packet of packets) {
      page.set(packet, at);
      at += packet.length;
    }
    view.setUint32(22, crc32(page), true);
    return page;
  }
}
