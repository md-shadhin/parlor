// Centralised configuration, loaded once from the environment (.env supported).
import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `\nMissing ${name}. Create node-server/.env (see .env.example) with:\n` +
        `  ${name}=your_key_here\n` +
        `Get a free key at https://aistudio.google.com/apikey\n`,
    );
    process.exit(1);
  }
  return value;
}

export interface AppConfig {
  port: number;
  gemini: {
    apiKey: string;
    understandModel: string;
    baseUrl: string;
  };
  tts: {
    voice: string;
  };
  live: {
    model: string;
    port: number;
    voice: string;
  };
  audio: {
    sampleRate: number;
  };
}

export const config: AppConfig = {
  port: Number(process.env.PORT ?? 8000),

  gemini: {
    apiKey: required('GEMINI_API_KEY'),
    // Multimodal (audio + vision) understanding model.
    understandModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },

  tts: {
    // Native Bangladeshi Bengali neural voice via Microsoft Edge TTS (free, no key).
    // bn-BD-PradeepNeural = male; bn-BD-NabanitaNeural = female.
    voice: process.env.TTS_VOICE ?? 'bn-BD-PradeepNeural',
  },

  // Gemini Live API — used only by the separate real-time entrypoint (live.ts).
  // Native speech-to-speech: built-in VAD + interruption, Bengali auto-detected.
  live: {
    model: process.env.LIVE_MODEL ?? 'gemini-3.1-flash-live-preview',
    port: Number(process.env.LIVE_PORT ?? 8001),
    // Prebuilt HD voice (language comes from the audio/prompt, not the voice).
    voice: process.env.LIVE_VOICE ?? 'Charon',
  },

  // Advertised sample rate for the audio_start frame. Edge TTS returns MP3
  // (24 kHz), which the browser decodes natively.
  audio: {
    sampleRate: 24000,
  },
};
