// Text-to-speech via Microsoft Edge TTS (free, no API key) using a native
// Bangladeshi Bengali neural voice — the closest to natural, native-sounding
// speech for this app. Node equivalent of src/tts.py.
//
// The free Edge endpoint only serves compressed audio, so the reply reaches the
// browser as an MP3 chunk (the frontend decodes it via decodeAudioData, keyed
// off `format: "mp3"`). One client owns one Edge connection, created lazily and
// reconnected if it goes stale.
//
// createTtsClient() returns { synthesize(text, signal) -> base64 MP3 }. The
// single-function shape means another backend (Gemini TTS, Azure, Cloud TTS…)
// could be dropped in without touching the server.

import type { Readable } from 'node:stream';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { config } from './config.js';
import { errName } from './util.js';

const MP3_FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

/** The wire format of the chunks this backend emits (sent on each audio_chunk). */
export const audioFormat = 'mp3';

/** Sample rate advertised in audio_start (MP3 carries its own rate for decode). */
export const sampleRate = config.audio.sampleRate;

export interface TtsClient {
  synthesize(text: string, signal?: AbortSignal): Promise<string>;
  sampleRate: number;
  audioFormat: string;
}

class AbortError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

function collect(stream: Readable, signal?: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => finish(reject, new Error('Edge TTS timeout')), 20000);

    const onAbort = () => finish(reject, new AbortError());
    const finish = (fn: (arg: never) => void, arg: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      (fn as (a: unknown) => void)(arg);
    };

    if (signal?.aborted) return finish(reject, new AbortError());
    signal?.addEventListener('abort', onAbort);

    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => finish(resolve, Buffer.concat(chunks)));
    stream.on('error', (e: Error) => finish(reject, e));
  });
}

export function createTtsClient(voice: string = config.tts.voice): TtsClient {
  let tts: MsEdgeTTS | null = null;
  let queue: Promise<unknown> = Promise.resolve(); // one Edge socket at a time per client

  async function synthOnce(text: string, signal?: AbortSignal, retried = false): Promise<Buffer> {
    try {
      if (!tts) {
        tts = new MsEdgeTTS();
        await tts.setMetadata(voice, MP3_FORMAT);
      }
      const { audioStream } = await tts.toStream(text);
      return await collect(audioStream, signal);
    } catch (err) {
      tts = null; // stale Edge websocket — reconnect on retry
      if (!retried && errName(err) !== 'AbortError') return synthOnce(text, signal, true);
      throw err;
    }
  }

  return {
    /** Synthesize the reply to base64-encoded MP3. */
    async synthesize(text: string, signal?: AbortSignal): Promise<string> {
      const run = queue.then(() => synthOnce(text, signal));
      queue = run.catch(() => {}); // keep the chain alive after a failure
      const buf = await run;
      return buf.toString('base64');
    },
    sampleRate,
    audioFormat,
  };
}
