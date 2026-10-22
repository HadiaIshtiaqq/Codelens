// Tiny Web Audio sound effects: no asset files, nothing loaded from the network.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, start: number, duration: number, type: OscillatorType = 'square', gain = 0.05) {
  const a = audio();
  if (!a) return;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = a.currentTime + start;
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + duration);
}

export type Sfx = 'step' | 'call' | 'return' | 'print' | 'crash' | 'win' | 'correct' | 'wrong' | 'achievement';

export function play(sfx: Sfx) {
  switch (sfx) {
    case 'step':
      return tone(660, 0, 0.04, 'triangle', 0.025);
    case 'call':
      tone(440, 0, 0.06, 'square', 0.03);
      return tone(660, 0.06, 0.08, 'square', 0.03);
    case 'return':
      tone(660, 0, 0.06, 'square', 0.03);
      return tone(440, 0.06, 0.08, 'square', 0.03);
    case 'print':
      return tone(1046, 0, 0.05, 'sine', 0.04);
    case 'crash':
      tone(180, 0, 0.25, 'sawtooth', 0.06);
      return tone(90, 0.1, 0.35, 'sawtooth', 0.06);
    case 'win':
      [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.09, 0.18, 'square', 0.04));
      return;
    case 'correct':
      tone(784, 0, 0.08, 'square', 0.04);
      return tone(1175, 0.08, 0.14, 'square', 0.04);
    case 'wrong':
      return tone(140, 0, 0.22, 'sawtooth', 0.05);
    case 'achievement':
      [880, 1175, 1568].forEach((f, i) => tone(f, i * 0.07, 0.16, 'triangle', 0.05));
      return;
  }
}
