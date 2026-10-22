// Kids progress: learned ideas and completed challenges, kept in this browser and portable
// to another device with a short "progress code" (there are no accounts).

const LEARNED_KEY = 'codelens.kids.learned';
const STARS_KEY = 'codelens.kids.stars';
const GAME_KEY = 'codelens.game.v1';

function readSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeSet(key: string, value: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...value]));
  } catch {
    /* storage unavailable */
  }
}

export const loadLearned = () => readSet(LEARNED_KEY);
export const saveLearned = (s: Set<string>) => writeSet(LEARNED_KEY, s);
export const loadStars = () => readSet(STARS_KEY);
export const saveStars = (s: Set<string>) => writeSet(STARS_KEY, s);

/** Everything worth carrying to another device, as one copy-and-paste code. */
export function exportProgress(): string {
  let game: unknown = null;
  try {
    game = JSON.parse(localStorage.getItem(GAME_KEY) ?? 'null');
  } catch {
    game = null;
  }
  const json = JSON.stringify({ v: 1, learned: [...loadLearned()], stars: [...loadStars()], game });
  return 'CL1-' + btoa(unescape(encodeURIComponent(json)));
}

/** Restore a progress code; returns a short description, or throws if the code is not valid. */
export function importProgress(code: string): string {
  const trimmed = code.trim();
  if (!trimmed.startsWith('CL1-')) throw new Error('That is not a CodeLens progress code.');
  const data = JSON.parse(decodeURIComponent(escape(atob(trimmed.slice(4)))));
  if (data?.v !== 1 || !Array.isArray(data.learned) || !Array.isArray(data.stars)) throw new Error('That progress code is damaged.');
  saveLearned(new Set([...loadLearned(), ...data.learned]));
  saveStars(new Set([...loadStars(), ...data.stars]));
  if (data.game && typeof data.game === 'object') {
    try {
      localStorage.setItem(GAME_KEY, JSON.stringify(data.game));
    } catch {
      /* ignore */
    }
  }
  return `Loaded ${data.stars.length} star(s) and ${data.learned.length} learned idea(s).`;
}
