import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripWavHeader } from './text.js';

test('stripWavHeader returns raw PCM unchanged when no header', () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  assert.equal(stripWavHeader(pcm).equals(pcm), true);
});

test('stripWavHeader extracts the data chunk from a WAV container', () => {
  const pcm = Buffer.from([9, 8, 7, 6]);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  const wav = Buffer.concat([header, pcm]);
  assert.equal(stripWavHeader(wav).equals(pcm), true);
});
