# Parlor — Bengali port (technical assessment)

> **Assessment submission.** This fork adapts [Parlor](#original-project-readme) — an on-device,
> English voice-and-vision assistant — into a **Bengali** experience whose new backend is written in
> **TypeScript / Node**. The original Python server is kept untouched as a reference; all new code is
> Node/TS. The original project README is preserved [below](#original-project-readme).

## What I built

- **Bengali localization.** All user-facing UI (`src/index.html`) and the language the AI is
  prompted to speak are Bengali, tuned for natural, colloquial Bangladeshi phrasing (not literal
  translation).
- **A TypeScript/Node service layer** (`node-server/`) that replaces the on-device Python inference
  with cloud APIs, so it runs **anywhere with just a free API key** — no GPU, no model download. It is
  a faithful port of the Python `src/server.py` WebSocket protocol and turn logic (per-connection
  turn queue, barge-in via `AbortController`, rolling text history).
  - **Understanding:** Gemini `gemini-2.5-flash` — audio + camera → `{transcription, response}` via
    structured JSON output (the Node analog of the Python `respond_to_user` tool).
  - **Speech:** Microsoft Edge TTS with a native Bangladeshi `bn-BD` neural voice — free, no key.
- **A second, real-time entrypoint** (`node-server/live.ts`) using the **Gemini Live API** — native
  speech-to-speech with built-in VAD, interruption, and transcription. Fully additive: it serves its
  own frontend on its own port and leaves the cascade app untouched.

## Run it (no GPU needed)

Requires **Node 18+** and a free [Gemini API key](https://aistudio.google.com/apikey).

```bash
cd node-server
npm install
cp .env.example .env          # then set GEMINI_API_KEY=...

npm start                     # cascade app   → http://localhost:8000
npm run live                  # real-time app → http://localhost:8001  (needs Live-model access)
```

Open the URL, grant camera + mic, and talk in Bengali. Also: `npm run typecheck` (`tsc --noEmit`) and
`npm test` (unit tests). The Node layer is TypeScript run directly via [`tsx`](https://github.com/privatenumber/tsx) — **no build step**.

| Variable | Default | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | **required**; free from Google AI Studio |
| `PORT` / `LIVE_PORT` | `8000` / `8001` | cascade / real-time server ports |
| `TTS_VOICE` | `bn-BD-PradeepNeural` | Edge TTS voice (`…NabanitaNeural` for female) |
| `GEMINI_MODEL` / `LIVE_MODEL` | `gemini-2.5-flash` / `gemini-3.1-flash-live-preview` | model overrides |

## Key decisions & tradeoffs

- **Gemini + Edge TTS, chosen deliberately.** Gemini's free tier handles Bengali audio + vision well.
  For voice, Edge TTS gives a genuinely *native* `bn-BD` voice for free — I evaluated ElevenLabs
  (Bengali isn't on its low-latency models) and Azure (same voice, but needs a key) before settling
  on Edge. The TTS backend is a single swappable `synthesize()` function.
- **One TTS request per turn**, not per sentence. Replies are short (1–4 sentences), so a single call
  cuts request count and keeps prosody smooth across sentence boundaries, trading a little
  first-audio latency.
- **TypeScript via `tsx`, no bundler.** Types cover the WebSocket protocols, config, and API payloads
  (`node-server/src/types.ts`), with zero build step so "it just runs" holds. The browser frontends
  stay plain JS on purpose (single self-contained files, no build).
- **No runtime CDN dependency.** The browser VAD/ONNX libraries are vendored and served locally — the
  original jsdelivr `<script>` tags had started returning bot-challenge pages.
- **Live API user-transcript is intentionally hidden.** Its `inputAudioTranscription` is a
  known-unreliable ASR (returns garbled text) even though the model understands the audio correctly,
  so the real-time UI shows a voice indicator instead of wrong text.

## What changed vs. the original

| | |
| --- | --- |
| **Localized / adapted** | `src/index.html` — Bengali UI + local vendored-asset paths |
| **New (my code)** | `node-server/` — TypeScript cascade server + Gemini Live proxy; `src/index-live.html` |
| **Unchanged (reference)** | `src/server.py`, `src/tts.py` — original on-device implementation |

```
src/
├── index.html            # localized to Bengali (shared by the cascade server)
├── index-live.html       # real-time (Gemini Live) frontend
├── server.py, tts.py     # original Python on-device server (reference, unchanged)
node-server/              # NEW — TypeScript/Node backend
├── server.ts             # cascade: Gemini understanding + Edge TTS
├── live.ts               # real-time: Gemini Live proxy
└── src/                  # config, gemini, tts, text, types, util (+ tests)
```

---

## Original project README

<sub>Everything below is the upstream project's README, preserved unchanged for reference.</sub>

# Parlor

On-device, real-time multimodal AI. Have natural voice and vision conversations with an AI that runs entirely on your machine.

Parlor uses [Gemma 4 E2B](https://huggingface.co/google/gemma-4-E2B-it) for understanding speech and vision, and [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) for text-to-speech. You talk, show your camera, and it talks back, all locally.

https://github.com/user-attachments/assets/cb0ffb2e-f84f-48e7-872c-c5f7b5c6d51f

> **Research preview.** This is an early experiment. Expect rough edges and bugs.

# Why?

I'm [self-hosting a totally free voice AI](https://www.fikrikarim.com/bule-ai-initial-release/) on my home server to help people learn speaking English. It has hundreds of monthly active users, and I've been thinking about how to keep it free while making it sustainable.

The obvious answer: run everything on-device, eliminating any server cost. Six months ago I needed an RTX 5090 to run just the voice models in real-time.

Google just released a super capable small model that I can run on my M3 Pro in real-time, with vision too! Sure you can't do agentic coding with this, but it is a game-changer for people learning a new language. Imagine a few years from now that people can run this locally on their phones. They can point their camera at objects and talk about them. And this model is multi-lingual, so people can always fallback to their native language if they want. This is essentially what OpenAI demoed a few years ago.

## How it works

```
Browser (mic + camera)
    │
    │  WebSocket (audio PCM + JPEG frames)
    ▼
FastAPI server
    ├── Gemma 4 E2B via LiteRT-LM (GPU)  →  understands speech + vision
    └── Kokoro TTS (MLX on Mac, ONNX on Linux)  →  speaks back
    │
    │  WebSocket (streamed audio chunks)
    ▼
Browser (playback + transcript)
```

- **Voice Activity Detection** in the browser ([Silero VAD](https://github.com/ricky0123/vad)). Hands-free, no push-to-talk.
- **Barge-in.** Interrupt the AI mid-sentence by speaking.
- **Sentence-level TTS streaming.** Audio starts playing before the full response is generated.

## Requirements

- Python 3.12+
- macOS with Apple Silicon, or Linux with a supported GPU
- ~3 GB free RAM for the model

## Quick start

```bash
git clone https://github.com/fikrikarim/parlor.git
cd parlor

# Install uv if you don't have it
curl -LsSf https://astral.sh/uv/install.sh | sh

cd src
uv sync
uv run server.py
```

Open [http://localhost:8000](http://localhost:8000), grant camera and microphone access, and start talking.

Models are downloaded automatically on first run (~2.6 GB for Gemma 4 E2B, plus TTS models).

## Configuration

| Variable     | Default                        | Description                                    |
| ------------ | ------------------------------ | ---------------------------------------------- |
| `MODEL_PATH` | auto-download from HuggingFace | Path to a local `gemma-4-E2B-it.litertlm` file |
| `PORT`       | `8000`                         | Server port                                    |

## Performance (Apple M3 Pro)

| Stage                            | Time          |
| -------------------------------- | ------------- |
| Speech + vision understanding    | ~1.8-2.2s     |
| Response generation (~25 tokens) | ~0.3s         |
| Text-to-speech (1-3 sentences)   | ~0.3-0.7s     |
| **Total end-to-end**             | **~2.5-3.0s** |

Decode speed: ~83 tokens/sec on GPU (Apple M3 Pro).

## Project structure

```
src/
├── server.py              # FastAPI WebSocket server + Gemma 4 inference
├── tts.py                 # Platform-aware TTS (MLX on Mac, ONNX on Linux)
├── index.html             # Frontend UI (VAD, camera, audio playback)
├── pyproject.toml         # Dependencies
└── benchmarks/
    ├── bench.py           # End-to-end WebSocket benchmark
    └── benchmark_tts.py   # TTS backend comparison
```

## Acknowledgments

- [Gemma 4](https://ai.google.dev/gemma) by Google DeepMind
- [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) by Google AI Edge
- [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) TTS by Hexgrad
- [Silero VAD](https://github.com/snakers4/silero-vad) for browser voice activity detection

## License

[Apache 2.0](LICENSE)
