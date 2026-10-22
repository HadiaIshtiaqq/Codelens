// Shareable links. The program travels in the URL fragment (never sent to the server).
//   #z=…     deflate-compressed JSON {s: main.py, f: {name: code}, i: program input}  (current)
//   #code=…  plain base64url main.py                                               (older links)

const PLAIN = '#code=';
const PACKED = '#z=';
/** Browsers and chat apps start truncating URLs around here. */
export const SAFE_URL_LENGTH = 32_000;

export interface SharedProgram {
  source: string;
  files: Record<string, string>;
  stdin: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): Uint8Array {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export function encodeSource(source: string): string {
  return toBase64Url(new TextEncoder().encode(source));
}

export function decodeSource(encoded: string): string | null {
  try {
    return new TextDecoder().decode(fromBase64Url(encoded));
  } catch {
    return null;
  }
}

export async function encodeProgram(program: SharedProgram): Promise<string> {
  const json = JSON.stringify({ s: program.source, f: program.files, i: program.stdin });
  return toBase64Url(await pipe(new TextEncoder().encode(json), new CompressionStream('deflate-raw')));
}

export async function decodeProgram(encoded: string): Promise<SharedProgram | null> {
  try {
    const json = new TextDecoder().decode(await pipe(fromBase64Url(encoded), new DecompressionStream('deflate-raw')));
    const data = JSON.parse(json);
    if (typeof data.s !== 'string') return null;
    return { source: data.s, files: data.f && typeof data.f === 'object' ? data.f : {}, stdin: typeof data.i === 'string' ? data.i : '' };
  } catch {
    return null;
  }
}

/** Old-style #code= links decode synchronously, so the first render already shows the code. */
export function sourceFromLocation(): string | null {
  const hash = typeof location !== 'undefined' ? location.hash : '';
  return hash.startsWith(PLAIN) ? decodeSource(hash.slice(PLAIN.length)) : null;
}

/** Compressed #z= links (with extra files and program input). */
export async function loadSharedProgram(): Promise<SharedProgram | null> {
  const hash = typeof location !== 'undefined' ? location.hash : '';
  return hash.startsWith(PACKED) ? decodeProgram(hash.slice(PACKED.length)) : null;
}

export async function shareUrl(program: SharedProgram): Promise<string> {
  return `${location.origin}${location.pathname}${PACKED}${await encodeProgram(program)}`;
}
