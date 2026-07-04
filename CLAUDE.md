# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Parlor is an on-device, real-time multimodal (voice + vision) AI assistant. A browser captures mic audio and camera frames, streams them over a WebSocket to a FastAPI server, which runs **Gemma 4 E2B** (via LiteRT-LM, on GPU) for combined speech+vision understanding and **Kokoro** for text-to-speech, then streams audio back. Everything runs locally — no external inference services.

## Commands

All commands run from the `src/` directory (that is where `pyproject.toml` lives). Dependencies are managed with **uv**.

```bash
cd src
uv sync                          # install deps
uv run server.py                 # run the server → http://localhost:8000

uv run python benchmarks/bench.py            # end-to-end WebSocket latency benchmark (server must be running)
uv run python benchmarks/benchmark_tts.py    # compare TTS backends (mlx-audio vs kokoro-onnx)
```

There is no test suite, linter, or formatter configured. The benchmarks are the primary way to validate performance changes.

Config via environment (`.env` in repo root is auto-loaded via python-dotenv, see `.env.example`):
- `MODEL_PATH` — path to a local `gemma-4-E2B-it.litertlm`; if unset, auto-downloads from HuggingFace (`litert-community/gemma-4-E2B-it-litert-lm`, ~2.6 GB, first run only).
- `PORT` — server port (default 8000).
- `KOKORO_ONNX` — if set, forces the ONNX TTS backend even on Apple Silicon.

Requires Python 3.12 (pinned `>=3.12,<3.13`).

## Architecture

Three source files in `src/` do the real work:

- **`server.py`** — FastAPI app. Loads the LiteRT-LM `Engine` once at startup (`lifespan` → `load_models`, run in an executor so it doesn't block the event loop). Serves `index.html` at `/` and the realtime protocol at `/ws`.
- **`tts.py`** — platform-aware TTS behind a single `TTSBackend` interface. `load()` picks `MLXBackend` (mlx-audio, Apple GPU) on Apple Silicon, else `ONNXBackend` (kokoro-onnx, CPU). Both output 24 kHz float PCM. Dependencies are split by platform in `pyproject.toml` via `sys_platform` markers.
- **`index.html`** — single-file frontend (~880 lines, no build step). Runs Silero VAD in-browser for hands-free turn-taking, captures camera frames as JPEG, plays back streamed audio chunks, and renders the transcript.

### Model interaction pattern (important)

The LLM is **not** used as a plain chat model. `server.py` registers a Python function `respond_to_user(transcription, response)` as a **tool** on the conversation, and the system prompt forces the model to call it. This makes the model both transcribe the user's speech and produce a reply in one structured call. The tool writes into a per-connection `tool_result` dict via closure; the handler reads it after inference. There is a fallback path that reads raw text if the model skips the tool call. Text like `<|"|>` is stripped from tool outputs.

Each WebSocket connection creates its own `conversation` (with the system prompt + tool) so state is isolated per client. Blocking calls (`conversation.send_message`, `tts_backend.generate`) are dispatched to an executor to keep the async server responsive.

### WebSocket protocol (`/ws`)

A background `receiver` task reads client messages into a queue and separates control from data. Client → server (JSON):
- `{ audio?, image?, text? }` — base64 audio (WAV) and/or JPEG frame for a turn.
- `{ type: "interrupt" }` — barge-in; sets an `asyncio.Event` checked at every stage (after LLM, before TTS, between sentences) to abandon the in-flight response.

Server → client (JSON): a `text` reply message (with `transcription` and `llm_time`), then a TTS stream framed as `audio_start` (carries `sample_rate` + `sentence_count`) → repeated `audio_chunk` (base64 int16 PCM, one per sentence) → `audio_end`. **TTS is streamed sentence-by-sentence** (`split_sentences` on `.!?`) so playback starts before the full response is synthesized.

### Barge-in / echo handling

Interruption spans both ends: the browser raises the VAD threshold and applies an 800 ms grace period after TTS start to avoid the AI's own audio re-triggering VAD (echo), and the server checks the `interrupted` event between every generation step. When touching turn-taking, keep both sides in sync.

## `node-server/` — Bengali cloud runtime (Node.js)

An alternate, **runnable-anywhere** backend that replaces the on-device Python inference with cloud calls, written in **TypeScript** (ESM, Node 18+, run via `tsx` — no build step). Deps: `ws`, `dotenv`, `msedge-tts`, `@google/genai` (+ dev: `tsx`, `typescript`, `@types/*`); `onnxruntime-web` + `@ricky0123/vad-web` are vendored browser libs. It is a faithful port of `src/server.py`'s WebSocket protocol and turn logic, serving the **same** `src/index.html` (localized to Bengali). The one protocol addition: audio chunks carry `format: "mp3"` (Edge TTS is compressed), which the frontend `queueAudioChunk` decodes via `decodeAudioData` — the raw-PCM path is kept as a fallback.

The browser frontends (`src/index.html`, `src/index-live.html`) are deliberately left as plain JS (single self-contained files, no bundler). The wire protocols and shared shapes are typed in `node-server/src/types.ts`. `npm run typecheck` runs `tsc --noEmit`.

The server also serves the browser VAD/ONNX libraries locally under `/vendor/onnx/` and `/vendor/vad/` (streamed from `node_modules`), so the app has **no runtime CDN dependency** — the original jsdelivr `<script>` tags were unreliable (bot-challenge 403s). Note: because `src/index.html` now points at these local paths, VAD only loads under the Node server; the Python reference server would need the same static routes to run the frontend.

- `node-server/server.ts` — HTTP (serves `../src/index.html`) + `WebSocketServer` on `/ws`. Per connection: a turn queue drained one at a time; barge-in `{type:"interrupt"}` aborts the in-flight turn via a per-turn `AbortController` (the Node analog of the Python `interrupted` Event); lightweight **text-only** history gives conversational memory without re-sending audio.
- `node-server/src/gemini.ts` — `understand()` calls `gemini-2.5-flash` with audio+image parts and **structured JSON output** `{transcription, response}` (this replaces the Python `respond_to_user` tool; same intent). Bengali is enforced in the system instruction; `thinkingBudget: 0` lowers latency.
- `node-server/src/tts.ts` — `createTtsClient()` returns a per-connection `synthesize(text, signal)` that uses **Microsoft Edge TTS** (`msedge-tts`) with a native Bengali voice (default `bn-BD-PradeepNeural`, male; set `TTS_VOICE` to change) — free, no key. Returns base64 MP3. Single-function interface so another TTS (Gemini/Azure/Cloud TTS bn-IN) can drop in.
- `node-server/src/text.ts` — PCM/base64 helpers for the TTS audio path (`base64ToBuffer`, `stripWavHeader`). Unit-tested in `text.test.ts` (`npm test`, via `tsx`). Shared protocol/config types live in `src/types.ts`.

Unlike the Python server (which streams TTS sentence-by-sentence), the Node server synthesizes the **whole reply in one TTS request per turn** — replies are short (1–4 sentences), so this spends fewer requests and keeps prosody smooth across sentence boundaries, at the cost of a slightly later first-audio. Audio is only sent (`audio_start`→`audio_chunk`→`audio_end`) once synthesis succeeds, so a TTS failure never strands the client in the "speaking" state.

Config via `node-server/.env` (`GEMINI_API_KEY` required; optional `PORT`, `GEMINI_MODEL`, `TTS_VOICE`). Run: `cd node-server && npm install && npm start`.

### Real-time variant — `node-server/live.ts` (`npm run live`)

A **separate, additive entrypoint** (own port, default 8001; serves its own `src/index-live.html`) that replaces the turn-based cascade with the **Gemini Live API** (`@google/genai`, `ai.live.connect`) — native speech-to-speech with built-in VAD, interruption, and transcription. `server.ts` / `index.html` are untouched.

- Architecture is a **proxy**, not a pipeline: the browser streams continuous 16 kHz PCM (captured via an inline AudioWorklet, no Silero VAD) + periodic JPEG frames over `/ws`; `live.ts` relays them to a Live session via `sendRealtimeInput({audio|video})`, and relays back the model's 24 kHz PCM audio, `inputTranscription`/`outputTranscription` deltas, and `interrupted`/`turnComplete` events. Browser input is buffered until the async Live handshake completes.
- Bengali is enforced via the Live `systemInstruction` (the native-audio model auto-detects language; the voice — default `LIVE_VOICE` — is language-agnostic).
- **User-side transcript is intentionally not shown.** The Live API's `inputAudioTranscription` is a known-unreliable ASR (returns garbled/random text even though the model understands the audio correctly — see Google's forums). `index-live.html` uses the input-transcription event only as a "user is speaking" signal to render a mic/voice indicator bubble; the assistant's `outputAudioTranscription` (accurate) streams normally. Don't "fix" this by rendering the input text — it's wrong at the source.
- Preview model (`gemini-3.1-flash-live-preview`, `LIVE_MODEL`); the key needs Live access. Metered per audio token/second with session limits, unlike the cascade's per-request model.

## `artifacts/`

Design and research notes (model overview, LiteRT-LM guide, TTS options, benchmarks, UI research) written during development. Reference material, not runtime code.
