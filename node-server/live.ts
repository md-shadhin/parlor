// Parlor — real-time entrypoint (Gemini Live API).
//
// A SEPARATE, self-contained entrypoint that proxies the browser to a Gemini
// Live session. Unlike server.ts (a turn-based cascade: browser VAD → Gemini
// understand → Edge TTS), this uses native speech-to-speech: the model does its
// own VAD, interruption, transcription, and audio output end-to-end.
//
// Nothing here touches server.ts / src/index.html — it serves its own frontend
// (src/index-live.html) on its own port. Run with:  npm run live
//
// Browser → this server (JSON): { type:"audio"|"video", data }
// This server → browser (JSON): audio | input_transcription | output_transcription
//                               | interrupted | turn_complete | ready | error

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { GoogleGenAI, Modality, type LiveServerMessage } from '@google/genai';

import { config } from './src/config.js';
import type { LiveInMsg, LiveOutMsg } from './src/types.js';
import { errMessage } from './src/util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '..', 'src', 'index-live.html');

const SYSTEM_INSTRUCTION =
  'You are পার্লার, a warm and friendly conversational companion. The user talks ' +
  'to you by voice and may show you their camera. ALWAYS speak in natural, native, ' +
  'colloquial Bengali (বাংলা) — the way a friendly Bangladeshi person actually ' +
  'speaks, never stiff or robotic. Keep replies short and conversational. Even if ' +
  'the user speaks another language, reply in Bengali.';

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
type LiveSession = Awaited<ReturnType<typeof ai.live.connect>>;

// ── HTTP: serve the Live frontend ───────────────────────────────────────────
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
  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket: bridge browser ⇄ Gemini Live ────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', async (ws: WebSocket) => {
  console.log('Client connected');

  const send = (obj: LiveOutMsg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  // Buffer browser input that arrives before the Live session is ready.
  let session: LiveSession | null = null;
  let closed = false;
  const pending: LiveInMsg[] = [];

  function forwardToLive(msg: LiveInMsg) {
    if (!session || !msg.data) return;
    if (msg.type === 'audio') {
      session.sendRealtimeInput({ audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' } });
    } else if (msg.type === 'video') {
      session.sendRealtimeInput({ video: { data: msg.data, mimeType: 'image/jpeg' } });
    }
  }

  // Register browser handlers up front so audio streamed during the (async)
  // Live handshake is buffered rather than dropped.
  ws.on('message', (raw: RawData) => {
    let msg: LiveInMsg;
    try {
      msg = JSON.parse(raw.toString()) as LiveInMsg;
    } catch {
      return;
    }
    if (session) forwardToLive(msg);
    else pending.push(msg);
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    closed = true;
    session?.close();
  });

  ws.on('error', (err: Error) => console.error('WebSocket error:', err.message));

  // Relay a message from Gemini Live back to the browser.
  function onLiveMessage(message: LiveServerMessage) {
    const content = message.serverContent;
    if (!content) return;

    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        const audio = part.inlineData?.data;
        if (audio) send({ type: 'audio', data: audio }); // PCM @ 24 kHz
      }
    }
    if (content.inputTranscription?.text) {
      send({ type: 'input_transcription', text: content.inputTranscription.text });
    }
    if (content.outputTranscription?.text) {
      send({ type: 'output_transcription', text: content.outputTranscription.text });
    }
    if (content.interrupted) send({ type: 'interrupted' });
    if (content.turnComplete) send({ type: 'turn_complete' });
  }

  try {
    session = await ai.live.connect({
      model: config.live.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: SYSTEM_INSTRUCTION,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.live.voice } } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => console.log('Live session opened'),
        onmessage: onLiveMessage,
        onerror: (e) => {
          console.error('Live error:', e.message);
          send({ type: 'error', message: 'লাইভ সংযোগে সমস্যা হয়েছে।' });
        },
        onclose: () => {
          if (!closed) ws.close();
        },
      },
    });
  } catch (err) {
    console.error('Failed to open Live session:', errMessage(err));
    send({ type: 'error', message: 'লাইভ সেশন শুরু করা যায়নি। GEMINI_API_KEY ও মডেল অ্যাক্সেস যাচাই করুন।' });
    ws.close();
    return;
  }

  if (closed) {
    session.close();
    return;
  }
  send({ type: 'ready' });
  for (const msg of pending) forwardToLive(msg);
  pending.length = 0;
});

httpServer.listen(config.live.port, () => {
  console.log(`Parlor Live (Node) listening on http://localhost:${config.live.port}`);
  console.log(`  model: ${config.live.model} (Gemini Live API, native audio)`);
  console.log(`  voice: ${config.live.voice}`);
});
