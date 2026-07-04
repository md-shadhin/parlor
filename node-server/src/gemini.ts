// Multimodal understanding via the Gemini API.
//
// This is the Node equivalent of the Python `respond_to_user` tool flow in
// src/server.py. Instead of forcing a tool call, we ask Gemini for structured
// JSON output with the same two fields — {transcription, response} — which is
// simpler and more reliable while preserving the original intent: the model
// both transcribes what the user said and writes a reply, in one call.

import { config } from './config.js';
import type { HistoryTurn, Turn, UnderstandResult } from './types.js';

// Ported from server.py SYSTEM_PROMPT, adapted for Bengali conversation.
const SYSTEM_PROMPT =
  'You are পার্লার, a warm and friendly conversational AI assistant. ' +
  'The user is talking to you through a microphone and may show you their camera. ' +
  'ALWAYS reply in natural, native, colloquial Bengali (বাংলা) — the way a friendly ' +
  'Bangladeshi person actually speaks, never stiff, literal, or robotic. ' +
  'Keep replies short: 1–4 sentences. ' +
  'First transcribe exactly what the user said in the audio (in Bengali script) into ' +
  '"transcription", then write your spoken reply into "response". ' +
  'If the audio is not in Bengali, still write your "response" in Bengali.';

// Per-turn instruction texts, ported from server.py. These steer the model and
// stay in English; the Bengali output is enforced above.
const INSTRUCTIONS = {
  audioImage:
    'The user just spoke to you (audio) while showing their camera (image). ' +
    'Respond to what they said, referencing what you see if relevant.',
  audio: 'The user just spoke to you. Respond to what they said.',
  image: 'The user is showing you their camera. Describe what you see.',
  text: 'Reply to the user.',
} as const;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    transcription: {
      type: 'string',
      description: "Exact transcription of the user's speech, in Bengali script.",
    },
    response: {
      type: 'string',
      description: 'Your conversational reply to the user, in natural Bengali.',
    },
  },
  required: ['transcription', 'response'],
  propertyOrdering: ['transcription', 'response'],
};

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

function pickInstruction(hasAudio: boolean, hasImage: boolean, text?: string): string {
  if (hasAudio && hasImage) return INSTRUCTIONS.audioImage;
  if (hasAudio) return INSTRUCTIONS.audio;
  if (hasImage) return INSTRUCTIONS.image;
  return text || INSTRUCTIONS.text;
}

/**
 * Understand a user turn and produce a Bengali reply.
 *
 * @param turn     audio (base64 WAV) and/or image (base64 JPEG), or text
 * @param history  prior turns (text only) for conversational memory
 * @param signal   aborts the request on barge-in
 */
export async function understand(
  { audio, image, text }: Turn,
  history: HistoryTurn[] = [],
  signal?: AbortSignal,
): Promise<UnderstandResult> {
  const parts: GeminiPart[] = [];
  if (audio) parts.push({ inlineData: { mimeType: 'audio/wav', data: audio } });
  if (image) parts.push({ inlineData: { mimeType: 'image/jpeg', data: image } });
  parts.push({ text: pickInstruction(Boolean(audio), Boolean(image), text) });

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    // Prior turns give the model conversational memory. We only keep text
    // (transcriptions + replies) in history, never re-sending heavy audio/image.
    contents: [...history, { role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.7,
      // Disable 2.5-flash's thinking phase — cuts time-to-first-token, which
      // matters for a realtime voice loop.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const url =
    `${config.gemini.baseUrl}/models/${config.gemini.understandModel}:generateContent` +
    `?key=${config.gemini.apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini understand failed (${res.status}): ${detail.slice(0, 500)}`);
  }

  const data = (await res.json()) as GenerateContentResponse;
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    throw new Error(`Gemini returned no content: ${JSON.stringify(data).slice(0, 500)}`);
  }

  try {
    const parsed = JSON.parse(raw) as Partial<UnderstandResult>;
    return {
      transcription: (parsed.transcription ?? '').trim(),
      response: (parsed.response ?? '').trim(),
    };
  } catch {
    // Structured output should always be valid JSON, but fall back gracefully:
    // treat the whole text as the reply with no transcription.
    return { transcription: '', response: raw.trim() };
  }
}
