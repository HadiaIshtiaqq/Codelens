// Read text aloud with the browser's built-in voices (no network, no audio files).

export const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

/** Remove emoji and symbols the voice would read out awkwardly. */
export function speakable(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/[“”]/g, '"')
    // Symbols from the step explanations, spoken as words.
    .replace(/\s*→\s*/g, ', so ')
    .replace(/[◀▶…]/g, ' ')
    .replace(/ == /g, ' is equal to ')
    .replace(/ != /g, ' is not equal to ')
    .replace(/ = /g, ' equals ')
    .replace(/\s+/g, ' ')
    .trim();
}

const VOICE_KEY = 'codelens.voice';

/** English voices installed in this browser (they differ by device; many sound much better than the default). */
export function englishVoices(): SpeechSynthesisVoice[] {
  if (!speechSupported) return [];
  return window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'));
}

export function chosenVoiceName(): string {
  try {
    return localStorage.getItem(VOICE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function chooseVoice(name: string) {
  try {
    localStorage.setItem(VOICE_KEY, name);
  } catch {
    /* ignore */
  }
}

/** Call `cb` now and whenever the browser finishes loading its voice list. */
export function onVoicesChanged(cb: () => void): () => void {
  if (!speechSupported) return () => {};
  cb();
  window.speechSynthesis.addEventListener('voiceschanged', cb);
  return () => window.speechSynthesis.removeEventListener('voiceschanged', cb);
}

export function speak(text: string, onEnd?: () => void): void {
  if (!speechSupported) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(speakable(text));
  const voice = englishVoices().find((v) => v.name === chosenVoiceName());
  if (voice) utterance.voice = voice;
  utterance.rate = 0.9; // a little slower, for young listeners
  utterance.pitch = 1.1;
  if (onEnd) {
    utterance.onend = onEnd;
    utterance.onerror = onEnd;
  }
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (speechSupported) window.speechSynthesis.cancel();
}
