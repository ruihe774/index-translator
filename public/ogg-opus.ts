// Ogg Opus (RFC 7845), mono or stereo (channel mapping family 0), shared by the server and the page:
// no Bun, no DOM. The streaming muxer is ported from libopus-wasm's `OggOpusMuxer`, without its
// encoder; it wraps the packets of libopus in src/opus-stream.ts (the speech stream) and of the
// browser's AudioEncoder in public/audio-upload.ts (uploads). The demuxer reads those uploads back
// (src/opus-file.ts): a subset of Ogg, one logical stream from granule 0, which is what any Opus
// encoder writes, ours included.

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

/** Ogg's CRC-32: polynomial 0x04c11db7, no reflection, initial value and final xor 0; `crc` continues one. */
function crc32(data: Uint8Array, crc = 0): number {
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
  /** The stream's serial number (not `serial`, which compat/compat takes for the Web Serial API). */
  private readonly streamSerial: number;
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
    this.streamSerial = (options.serial ?? Math.random() * 2 ** 32) >>> 0;
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
    view.setUint32(14, this.streamSerial, true);
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

/** Samples per frame at 48 kHz of each TOC configuration (RFC 6716, 3.1): SILK, hybrid, CELT. */
// prettier-ignore
const FRAME_SAMPLES = [
  480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880,
  480, 960, 480, 960,
  120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960,
];

/** The longest a packet can play: 120 ms at 48 kHz. */
const MAX_PACKET_SAMPLES = 5760;

/**
 * Samples per channel at 48 kHz that an Opus packet decodes to, read from its TOC byte without decoding
 * it (RFC 6716, 3.1). Throws when the packet cannot be one.
 */
export function opusPacketSamples(packet: Uint8Array): number {
  const [toc] = packet;
  if (toc === undefined) {
    throw new Error("an Opus packet is empty");
  }
  const code = toc & 3;
  // Code 3 says how many frames in its second byte.
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  const samples = frames * FRAME_SAMPLES[toc >> 3]!;
  if (samples === 0 || samples > MAX_PACKET_SAMPLES) {
    throw new Error("an Opus packet is damaged");
  }
  return samples;
}

/** The identification header of an Ogg Opus stream, as far as a family-0 decoder needs it. */
export interface OpusHead {
  channels: 1 | 2;
  /** 48 kHz samples the decoder drops from the start. */
  preSkip: number;
  /** The rate of the original audio; informational. */
  inputSampleRate: number;
  /** Gain to apply to the decoded audio, in dB × 256 (Q7.8). */
  outputGain: number;
}

/** What `demuxOggOpus` finds: the header and the audio packets in order. */
export interface OggOpus {
  head: OpusHead;
  packets: Uint8Array[];
  /** Samples per channel at 48 kHz the stream plays: from its last granule position, pre-skip left out. */
  frames: number;
}

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

function parseHead(packet: Uint8Array): OpusHead {
  if (packet.length < 19 || ascii(packet, 0, 8) !== "OpusHead") {
    throw new Error("the Ogg file does not hold Opus");
  }
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  // Versions 0.x are compatible with one another; a new major version is not.
  if (packet[8]! >> 4 !== 0) {
    throw new Error(`the Opus header version ${packet[8]} is not supported`);
  }
  const channels = packet[9]!;
  const family = packet[18]!;
  if (family !== 0 || (channels !== 1 && channels !== 2)) {
    throw new Error(`only mono and stereo Opus is supported (${channels} channels, mapping family ${family})`);
  }
  return {
    channels,
    preSkip: view.getUint16(10, true),
    inputSampleRate: view.getUint32(12, true),
    outputGain: view.getInt16(16, true),
  };
}

/** A page's granule position that marks no packet end. */
const NO_GRANULE = 0xff_ff_ff_ff_ff_ff_ff_ffn;

/**
 * Splits an Ogg Opus file into its header and packets, checking every page (capture pattern, checksum,
 * sequence) and that the last granule position fits the packets. A subset of Ogg: one logical stream (no
 * chaining, no multiplexing), with nothing before its first page or after its last, starting at granule
 * 0 (no trim at the start). Packets may span pages. Throws an Error that says what is wrong with the file.
 */
export function demuxOggOpus(bytes: Uint8Array): OggOpus {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cutOff = () => new Error("the Ogg file is cut off");
  const all: Uint8Array[] = [];
  let partial: Uint8Array[] = [];
  let serial: number | undefined;
  let sequence = 0;
  let granule: bigint | undefined;
  for (let at = 0; at < bytes.length;) {
    if (at + 27 > bytes.length || ascii(bytes, at, at + 4) !== "OggS") {
      throw at === 0 ? new Error("not an Ogg file") : cutOff();
    }
    if (bytes[at + 4] !== 0) {
      throw new Error(`the Ogg page version ${bytes[at + 4]} is not supported`);
    }
    const flags = bytes[at + 5]!;
    const pageSerial = view.getUint32(at + 14, true);
    if (serial === undefined) {
      if (!(flags & 0x02)) {
        throw new Error("the Ogg file does not start at the beginning of its stream");
      }
      serial = pageSerial;
    } else if (pageSerial !== serial) {
      throw new Error("the Ogg file holds more than one stream");
    }
    if (view.getUint32(at + 18, true) !== sequence++) {
      throw new Error("pages of the Ogg file are missing or out of order");
    }
    const count = bytes[at + 26]!;
    const lacing = bytes.subarray(at + 27, at + 27 + count);
    const body = at + 27 + count;
    const end = body + lacing.reduce((n, l) => n + l, 0);
    if (body > bytes.length || end > bytes.length) {
      throw cutOff();
    }
    // The checksum is computed with its own field as zero.
    let crc = crc32(bytes.subarray(at, at + 22));
    crc = crc32(new Uint8Array(4), crc);
    crc = crc32(bytes.subarray(at + 26, end), crc);
    if (crc !== view.getUint32(at + 22, true)) {
      throw new Error("the Ogg file is damaged (a page's checksum does not match)");
    }
    if (Boolean(flags & 0x01) !== partial.length > 0) {
      throw new Error("the Ogg file is damaged (a packet is cut off)");
    }
    let from = body;
    let size = 0;
    let ended = false;
    for (const l of lacing) {
      size += l;
      // A packet ends at a lacing value under 255; what came since `from` is its (last) part.
      if (l < 255) {
        partial.push(bytes.subarray(from, from + size));
        all.push(partial.length === 1 ? partial[0]! : concat(partial));
        partial = [];
        from += size;
        size = 0;
        ended = true;
      }
    }
    // The rest goes on in the next page.
    if (from < end) {
      partial.push(bytes.subarray(from, end));
    }
    const position = view.getBigUint64(at + 6, true);
    if (ended && position !== NO_GRANULE) {
      granule = position;
    }
    at = end;
    if (flags & 0x04 && at < bytes.length) {
      throw new Error("the Ogg file holds more than one stream");
    }
  }
  if (partial.length > 0) {
    throw cutOff();
  }
  if (all.length < 2) {
    throw new Error(all.length === 0 ? "the file is empty" : "the Ogg Opus file has no comment header");
  }
  const head = parseHead(all[0]!);
  if (all[1]!.length < 8 || ascii(all[1]!, 0, 8) !== "OpusTags") {
    throw new Error("the Ogg Opus file has no comment header");
  }
  const packets = all.slice(2);
  let total = 0;
  for (const packet of packets) {
    total += opusPacketSamples(packet);
  }
  const last = granule ?? 0n;
  if (last > BigInt(total)) {
    throw new Error("the Ogg granule positions do not match the audio");
  }
  const frames = Number(last) - head.preSkip;
  if (packets.length === 0 || frames < 1) {
    throw new Error("the Ogg Opus file has no audio");
  }
  return { head, packets, frames };
}
