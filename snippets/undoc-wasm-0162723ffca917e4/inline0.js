
export async function inflate(bytes, format) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
