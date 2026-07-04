// Shared types: WebSocket wire protocols + internal shapes.

/** A single content entry in Gemini's `contents` (we keep text-only history). */
export interface HistoryTurn {
  role: 'user' | 'model';
  parts: { text: string }[];
}

/** A user turn to be understood by the cascade server. */
export interface Turn {
  audio?: string; // base64 16 kHz mono WAV
  image?: string; // base64 JPEG
  text?: string;
}

/** Result of understanding a turn (mirrors the Python `respond_to_user` tool). */
export interface UnderstandResult {
  transcription: string;
  response: string;
}

// ── Cascade protocol (server.ts ⇄ index.html) ──────────────────────────────

/** Browser → cascade server. A data turn, or an interrupt control frame. */
export interface CascadeClientMessage {
  type?: 'interrupt';
  audio?: string;
  image?: string;
  text?: string;
}

/** Cascade server → browser. */
export type CascadeServerMessage =
  | { type: 'text'; text: string; transcription?: string; llm_time: number }
  | { type: 'audio_start'; sample_rate: number; sentence_count: number }
  | { type: 'audio_chunk'; audio: string; index: number; format?: string }
  | { type: 'audio_end'; tts_time: number }
  | { type: 'error'; message: string };

// ── Live protocol (live.ts ⇄ index-live.html) ──────────────────────────────

/** Browser → live proxy. Continuous audio + periodic video frames. */
export interface LiveInMsg {
  type?: 'audio' | 'video';
  data?: string;
}

/** Live proxy → browser. */
export type LiveOutMsg =
  | { type: 'ready' }
  | { type: 'audio'; data: string }
  | { type: 'input_transcription'; text: string }
  | { type: 'output_transcription'; text: string }
  | { type: 'interrupted' }
  | { type: 'turn_complete' }
  | { type: 'error'; message: string };
