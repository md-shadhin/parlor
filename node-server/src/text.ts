// PCM / base64 helpers for the TTS audio path.

/** Convert a base64-encoded blob to a Node Buffer. */
export function base64ToBuffer(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

/**
 * Some TTS backends wrap PCM in a WAV container. If a RIFF/WAVE header is
 * present, strip it down to the raw PCM `data` chunk; otherwise return the
 * buffer unchanged. The browser expects headerless Int16 PCM.
 */
export function stripWavHeader(buf: Buffer): Buffer {
  if (
    buf.length > 44 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WAVE'
  ) {
    // Walk the chunks to find "data" rather than assuming a fixed 44-byte header.
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const chunkId = buf.toString('ascii', offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);
      if (chunkId === 'data') {
        return buf.subarray(offset + 8, offset + 8 + chunkSize);
      }
      offset += 8 + chunkSize;
    }
  }
  return buf;
}
