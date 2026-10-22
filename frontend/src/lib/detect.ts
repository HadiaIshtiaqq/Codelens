// Cheap guess at what language a snippet is, used to offer "Convert to Python?" when
// non-Python code is run in the Python debugger. Only consulted after a SyntaxError.

const RULES: [string, RegExp[]][] = [
  ['C++', [/#include\s*<(iostream|vector|string|map)>/, /\bstd::/, /\bcout\s*<</]],
  ['C', [/#include\s*<stdio\.h>/, /\bprintf\s*\(/, /\bint\s+main\s*\(/]],
  ['Java', [/\bpublic\s+static\s+void\s+main\b/, /System\.out\.print/, /\bpublic\s+class\b/]],
  ['C#', [/Console\.Write(Line)?\s*\(/, /\busing\s+System\s*;/, /\bnamespace\s+\w+/]],
  ['Rust', [/\bfn\s+main\s*\(/, /println!\s*\(/, /\blet\s+mut\b/]],
  ['Go', [/^\s*package\s+main\b/m, /fmt\.Print/, /:=\s*/]],
  ['PHP', [/<\?php/, /\$\w+\s*=/, /\becho\s+/]],
  ['Kotlin', [/\bfun\s+main\s*\(/, /\bval\s+\w+\s*=/, /println\s*\(/]],
  ['Swift', [/\bfunc\s+\w+\s*\(/, /\bvar\s+\w+\s*:\s*\w+/, /\bguard\s+let\b/]],
  ['TypeScript', [/\binterface\s+\w+\s*\{/, /:\s*(number|string|boolean)\b/, /\bconsole\.log\s*\(/]],
  ['JavaScript', [/\bconsole\.log\s*\(/, /\bfunction\s+\w+\s*\(/, /\b(const|let|var)\s+\w+\s*=/, /=>\s*\{?/]],
  ['Ruby', [/^\s*puts\s+/m, /^\s*end\s*$/m, /\.each\s+do\b/]],
];

export function detectNonPython(code: string): string | null {
  let best: [string, number] | null = null;
  for (const [lang, patterns] of RULES) {
    const hits = patterns.filter((p) => p.test(code)).length;
    if (hits >= 1 && (!best || hits > best[1])) best = [lang, hits];
  }
  // Braces + semicolons are a strong generic signal even without a specific match.
  if (!best && /[;{]\s*$/m.test(code) && /^\s*\}/m.test(code)) return 'another language';
  return best ? best[0] : null;
}
