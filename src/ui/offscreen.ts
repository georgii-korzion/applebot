// Offscreen-документ: только проигрывание звука (SW сам звук играть не может).
import type { SoundKind } from '../shared/messages';

// [частота Гц, длительность мс] × повторы
const PATTERNS: Record<SoundKind, [number, number][]> = {
  open: [[880, 120], [0, 60], [1175, 160]],
  pay: [[988, 180], [0, 80], [988, 180], [0, 80], [1319, 420]],
  assist: [[1319, 140], [0, 70], [1319, 140], [0, 70], [1319, 140]],
  alert: [[440, 250], [0, 100], [330, 400]],
  done: [[784, 120], [988, 120], [1175, 120], [1568, 300]],
};

/** WAV (PCM 16 bit mono) из последовательности тонов — без внешних файлов. */
function wav(pattern: [number, number][]): string {
  const rate = 22050;
  const samples: number[] = [];
  for (const [f, ms] of pattern) {
    const n = Math.round((rate * ms) / 1000);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 200, (n - i) / 400);
      samples.push(f ? Math.sin((2 * Math.PI * f * i) / rate) * 0.45 * env : 0);
    }
  }
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const cache = new Map<SoundKind, string>();

chrome.runtime.onMessage.addListener((m: { target?: string; t?: string; kind?: SoundKind }) => {
  if (m?.target !== 'offscreen' || m.t !== 'PLAY' || !m.kind) return;
  const kind = m.kind;
  if (!cache.has(kind)) cache.set(kind, wav(PATTERNS[kind] ?? PATTERNS.alert));
  const a = new Audio(cache.get(kind));
  a.volume = 1;
  void a.play().catch((e) => console.warn('play failed', e));
});
