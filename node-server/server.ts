// Parlor — Node.js real-time voice + vision server (Bengali, Gemini-powered).
//
// A drop-in replacement for the Python FastAPI server in src/server.py. It
// speaks the exact same WebSocket protocol to the browser, so the frontend is
// unchanged apart from Bengali localization. Understanding and speech run in
// the cloud via the Gemini API instead of on-device models.

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

import { config } from './src/config.js';
import { understand } from './src/gemini.js';
import { createTtsClient, sampleRate, audioFormat } from './src/tts.js';
import type { CascadeClientMessage, CascadeServerMessage, HistoryTurn, Turn } from './src/types.js';
import { errMessage, errName } from './src/util.js';

// Cap rolling context so a long conversation doesn't grow unbounded.
const TURNS_LIMIT = 30; // user+model pairs

const __dirname = dirname(fileURLToPath(import.meta.url));
// The frontend is shared with the Python server; serve it from ../src.
const INDEX_PATH = join(__dirname, '..', 'src', 'index.html');

// Vendored browser libraries served locally, so the app has no runtime CDN
// dependency (jsdelivr was returning bot-challenge pages). npm restores these
// under node_modules; we stream them straight from there.
const VENDOR_DIRS: Record<string, string> = {
  '/vendor/onnx/': join(__dirname, 'node_modules', 'onnxruntime-web', 'dist'),
  '/vendor/vad/': join(__dirname, 'node_modules', '@ricky0123', 'vad-web', 'dist'),
};
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
};

function serveVendor(req: IncomingMessage, res: ServerResponse): boolean {
  const url = (req.url ?? '').split('?')[0];
  for (const [prefix, dir] of Object.entries(VENDOR_DIRS)) {
    if (!url.startsWith(prefix)) continue;
    // basename() strips any path so requests can't escape the vendor dir.
    const file = basename(decodeURIComponent(url.slice(prefix.length)));
    if (!file) break;
    const stream = createReadStream(join(dir, file));
    stream.on('open', () => {
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=86400',
      });
    });
    stream.on('error', () => {
      res.writeHead(404);
      res.end('Not found');
    });
    stream.pipe(res);
    return true;
  }
  return false;
}

// ── HTTP server: serve the frontend + vendored assets ──────────────────────
const httpServer = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/' || req.url === '/index.html') {
    try {
      const html = await readFile(INDEX_PATH);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end(`Failed to load frontend: ${errMessage(err)}`);
    }
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (serveVendor(req, res)) return;
  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server: the realtime protocol on /ws ──────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected');

  // Per-connection state.
  const history: HistoryTurn[] = []; // text-only prior turns for conversational memory
  const tts = createTtsClient(); // one Edge TTS connection per client
  const queue: Turn[] = []; // pending user turns, processed one at a time (like server.py)
  let draining = false;
  let activeController: AbortController | null = null; // aborts the in-flight turn on barge-in

  const send = (obj: CascadeServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  async function processTurn(turn: Turn, signal: AbortSignal) {
    // 1. Understand (audio + vision → transcription + Bengali reply).
    const t0 = Date.now();
    const { transcription, response } = await understand(turn, history, signal);
    const llmTime = (Date.now() - t0) / 1000;

    if (signal.aborted) return;

    console.log(
      `LLM (${llmTime.toFixed(2)}s) heard: ${JSON.stringify(transcription)} → ${response}`,
    );

    // Record this turn for future context, then trim to the rolling window.
    if (transcription) history.push({ role: 'user', parts: [{ text: transcription }] });
    if (response) history.push({ role: 'model', parts: [{ text: response }] });
    while (history.length > TURNS_LIMIT * 2) history.shift();

    // 2. Send the text reply (with transcription so the browser fills the bubble).
    const reply: Extract<CascadeServerMessage, { type: 'text' }> = {
      type: 'text',
      text: response,
      llm_time: Number(llmTime.toFixed(2)),
    };
    if (transcription) reply.transcription = transcription;
    send(reply);

    if (signal.aborted) return;

    // 3. Synthesize the whole reply in a single TTS request. Replies are short
    //    (1–4 sentences), so one call keeps prosody smooth across sentence
    //    boundaries and spends one request per turn instead of one per sentence.
    //    We synthesize before signalling audio_start, so a TTS failure never
    //    leaves the client stuck in the "speaking" state.
    const ttsStart = Date.now();
    let audioB64: string | undefined;
    try {
      audioB64 = await tts.synthesize(response, signal);
    } catch (err) {
      if (!signal.aborted && errName(err) !== 'AbortError') console.error('TTS error:', errMessage(err));
    }
    if (signal.aborted) return;
    if (!audioB64) {
      // The text reply was already delivered but speech synthesis failed. Tell
      // the client so it leaves "processing" instead of hanging there.
      send({ type: 'error', message: 'দুঃখিত, কণ্ঠ তৈরি করা যায়নি।' });
      return;
    }

    const ttsTime = (Date.now() - ttsStart) / 1000;
    console.log(`TTS (${ttsTime.toFixed(2)}s)`);

    send({ type: 'audio_start', sample_rate: sampleRate, sentence_count: 1 });
    send({ type: 'audio_chunk', audio: audioB64, index: 0, format: audioFormat });
    send({ type: 'audio_end', tts_time: Number(ttsTime.toFixed(2)) });
  }

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const turn = queue.shift()!;
      const controller = new AbortController();
      activeController = controller;
      try {
        await processTurn(turn, controller.signal);
      } catch (err) {
        if (controller.signal.aborted || errName(err) === 'AbortError') {
          console.log('Turn interrupted');
        } else {
          console.error('Turn failed:', errMessage(err));
          send({ type: 'error', message: 'দুঃখিত, একটি সমস্যা হয়েছে।' });
        }
      } finally {
        if (activeController === controller) activeController = null;
      }
    }
    draining = false;
  }

  ws.on('message', (raw: RawData) => {
    let msg: CascadeClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as CascadeClientMessage;
    } catch {
      return; // ignore malformed frames
    }

    if (msg.type === 'interrupt') {
      console.log('Client interrupted');
      activeController?.abort();
      return;
    }

    queue.push(msg);
    void drain();
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    activeController?.abort();
    queue.length = 0;
  });

  ws.on('error', (err: Error) => console.error('WebSocket error:', err.message));
});

httpServer.listen(config.port, () => {
  console.log(`Parlor (Node) listening on http://localhost:${config.port}`);
  console.log(`  understanding: ${config.gemini.understandModel} (Gemini API)`);
  console.log(`  tts:           Microsoft Edge TTS (voice: ${config.tts.voice})`);
});
