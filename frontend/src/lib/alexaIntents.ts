// Turns what someone says to the Alexa+ simulator into one CodeLens MCP tool call.
// Rule-based on purpose: it works offline, answers instantly and is easy to test.

export type Intent =
  | { kind: 'help' }
  | { kind: 'run' }
  | { kind: 'summary' }
  | { kind: 'variable'; name: string }
  | { kind: 'state'; step?: number }
  | { kind: 'show' }
  | { kind: 'fix' }
  | { kind: 'validate' }
  | { kind: 'apply' }
  | { kind: 'unknown' };

const WAKE = /^\s*(hey\s+|ok\s+)?alexa[\s,.!]*/i;
const POLITE = /^(please\s+|can you\s+|could you\s+|ask code ?lens (to\s+)?|tell code ?lens to\s+)+/i;

export function normalise(utterance: string): string {
  return utterance
    .replace(WAKE, '')
    .trim()
    .replace(POLITE, '')
    .replace(/[?!.]+$/g, '')
    .toLowerCase()
    .trim();
}

/** Speech recognisers write "total score" for `total_score` and "x" as "ex": match words to variable names. */
function mentionedVariable(text: string, variables: string[]): string | null {
  const squashed = ` ${text.replace(/[^a-z0-9_ ]/g, ' ').replace(/\s+/g, ' ')} `;
  const sorted = [...variables].sort((a, b) => b.length - a.length); // prefer the longest match
  for (const name of sorted) {
    const spoken = name.toLowerCase().replace(/_/g, ' ');
    if (squashed.includes(` ${spoken} `) || squashed.includes(` ${name.toLowerCase()} `)) return name;
  }
  return null;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export function parseIntent(utterance: string, variables: string[] = []): Intent {
  const text = normalise(utterance);
  if (!text) return { kind: 'unknown' };
  if (/\b(help|what can you do|what can i (say|ask))\b/.test(text)) return { kind: 'help' };
  if (/\b(validate|verify|test (the|that|this|my|your) (fix|change|patch)|check (the|that|your) fix|(does|did|will) (the|that|your) fix work|is (the|that|your) fix (right|correct|ok|good))\b/.test(text)) return { kind: 'validate' };
  if (/\b(apply|use|accept|keep) (the|that|this) (fix|patch|change)\b/.test(text)) return { kind: 'apply' };
  if (/\b(show me|point (to|at)|where('s| is) the (error|bug|problem|crash|mistake))\b/.test(text)) return { kind: 'show' };
  if (/\b(fix|repair|solve|correct|patch|make it work|how (do|can|should) i (fix|correct|solve))\b/.test(text)) return { kind: 'fix' };

  const step = text.match(/\bstep (\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (step) return { kind: 'state', step: (NUMBER_WORDS[step[1]] ?? Number(step[1])) - 1 };

  const asking = /\b(what|what's|whats|value|show|tell|how much|how many|where|which)\b/.test(text);
  const name = mentionedVariable(text, variables);
  if (name && asking) return { kind: 'variable', name };
  const named = text.match(/\b(?:value of|variable)\s+([a-z_][a-z0-9_]*)\b/) ?? text.match(/\bwhat(?:'s| is| was)(?: the)?\s+([a-z_][a-z0-9_]*)\b/);
  // "What is the error / problem / output?" are questions about the run, not variables called error or output.
  const notVariables = ['my', 'the', 'it', 'this', 'that', 'wrong', 'happening', 'going', 'happened', 'your', 'a', 'an'];
  const aboutTheRun = ['error', 'errors', 'problem', 'bug', 'issue', 'matter', 'mistake', 'crash', 'exception', 'output', 'result', 'answer'];
  if (named && aboutTheRun.includes(named[1]) && !variables.includes(named[1])) return { kind: 'summary' };
  if (named && !notVariables.includes(named[1])) {
    return { kind: 'variable', name: named[1] };
  }

  if (/\b(where (are we|is it|did it stop|is the program)|what line|which line|current line)\b/.test(text)) return { kind: 'state' };
  if (/\b(why|what went wrong|wrong|crash|crashed|error|bug|broken|fail|failed|summar|debug|problem|what happened|not working|doesn'?t work|isn'?t working)\b/.test(text)) return { kind: 'summary' };
  if (/\b(run|execute|start|try|explain|what does|what is my code|how does|go|test my code|check my code|does it work|what happens|play)\b/.test(text)) return { kind: 'run' };
  return { kind: 'unknown' };
}

export const SUGGESTIONS = ['Run my code', 'Why did it crash?', 'Fix it', 'Test the fix', 'Where did it stop?', 'What can you do?'];
