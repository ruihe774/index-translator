// Buffers whose every element the caller writes before reading any: not zeroed. `Bun.allocUnsafe` makes a
// fresh, exactly sized ArrayBuffer (offset 0, never pooled), so a wider view over it is aligned.

/** `length` uninitialized float samples. */
export function allocFloat32(length: number): Float32Array<ArrayBuffer> {
  return new Float32Array(Bun.allocUnsafe(length * Float32Array.BYTES_PER_ELEMENT).buffer);
}
