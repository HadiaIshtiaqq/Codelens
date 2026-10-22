// Kids challenges: a small mission, starter code, and an automatic check of the result.

export interface ChallengeResult {
  passed: boolean;
  message: string;
}

export interface Challenge {
  id: string;
  title: string;
  /** The mission, in a young beginner's words. */
  task: string;
  starter: string;
  hint: string;
  check: (source: string, stdout: string, error: string | null) => ChallengeResult;
}

const lines = (stdout: string) =>
  stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Compare printed lines with what the mission wants, explaining the first difference kindly. */
function expectLines(stdout: string, want: string[]): ChallengeResult {
  const got = lines(stdout);
  for (let i = 0; i < want.length; i++) {
    if (got[i] === undefined) return { passed: false, message: `Almost! The screen needs ${want.length} line(s), but only ${got.length} showed up.` };
    if (got[i].toLowerCase() !== want[i].toLowerCase())
      return { passed: false, message: `Line ${i + 1} on the screen says “${got[i]}”, but the mission wants “${want[i]}”.` };
  }
  if (got.length > want.length) return { passed: false, message: `Close! There are ${got.length - want.length} extra line(s) on the screen.` };
  return { passed: true, message: 'Mission complete!' };
}

function uses(source: string, word: RegExp, label: string): ChallengeResult | null {
  return word.test(source) ? null : { passed: false, message: `The screen looks right, but this mission asks you to use ${label}.` };
}

export const CHALLENGES: Challenge[] = [
  {
    id: 'hello',
    title: '👋 Say hello',
    task: 'Make Robo show the words Hello, world! on the screen.',
    starter: 'print("")\n',
    hint: 'Put the words between the quotes: print("Hello, world!")',
    check: (_s, out) => expectLines(out, ['Hello, world!']),
  },
  {
    id: 'apples',
    title: '🍎 Apple maths',
    task: 'You have 5 apples and eat 2. Put 5 in a box called apples, take 2 away, and show how many are left.',
    starter: 'apples = 5\n# take 2 away here\nprint(apples)\n',
    hint: 'You can write: apples = apples - 2',
    check: (s, out) => uses(s, /apples\s*(=\s*apples\s*-|-=)/, 'taking 2 away from the apples box') ?? expectLines(out, ['3']),
  },
  {
    id: 'cheers',
    title: '🎉 Three cheers',
    task: 'Show Hooray! three times, using a loop (not three print lines).',
    starter: 'for i in range(1):\n    print("Hooray!")\n',
    hint: 'range(3) counts 0, 1, 2: that is three times around the loop.',
    check: (s, out) => {
      const prints = (s.match(/print\s*\(/g) ?? []).length;
      if (prints > 1) return { passed: false, message: 'Try using just one print inside a loop!' };
      return uses(s, /\b(for|while)\b/, 'a loop') ?? expectLines(out, ['Hooray!', 'Hooray!', 'Hooray!']);
    },
  },
  {
    id: 'count',
    title: '🔢 Count to 10',
    task: 'Make Robo count from 1 to 10, one number on each line.',
    starter: 'for number in range(1, 5):\n    print(number)\n',
    hint: 'range stops just BEFORE its last number. To finish at 10, use range(1, 11).',
    check: (s, out) => uses(s, /\bfor\b|\bwhile\b/, 'a loop') ?? expectLines(out, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']),
  },
  {
    id: 'weather',
    title: '🧥 Hot or cold?',
    task: 'If the temperature is below 15, show Cold. Otherwise show Warm. Try it with temperature = 10.',
    starter: 'temperature = 10\nif temperature > 100:\n    print("Cold")\nelse:\n    print("Warm")\n',
    hint: 'The question should be: is the temperature smaller than 15? That is: temperature < 15',
    check: (s, out) => uses(s, /\bif\b/, 'an if question') ?? expectLines(out, ['Cold']),
  },
  {
    id: 'pets',
    title: '🐶 Pet parade',
    task: 'Make a list (a train) of 3 pets, then use a loop to show each pet on its own line.',
    starter: 'pets = ["cat"]\nfor pet in pets:\n    print(pet)\n',
    hint: 'Add more cars to the train: pets = ["cat", "dog", "fish"]',
    check: (s, out) => {
      const miss = uses(s, /\[[^\]]*,[^\]]*,[^\]]*\]/, 'a list with 3 things') ?? uses(s, /\bfor\b/, 'a loop');
      if (miss) return miss;
      return lines(out).length === 3 ? { passed: true, message: 'Mission complete!' } : { passed: false, message: `The screen shows ${lines(out).length} pet(s); the parade needs 3.` };
    },
  },
  {
    id: 'bug',
    title: '🐞 Fix the bug',
    task: 'Share 12 cookies equally among 3 friends, so each friend gets 4. Right now the program crashes!',
    starter: 'cookies = 12\nfriends = 0\nprint(cookies // friends)\n',
    hint: 'How many friends are there really? Change the friends box.',
    check: (_s, out, error) => (error ? { passed: false, message: 'The program still crashes. Look at the friends box.' } : expectLines(out, ['4'])),
  },
  {
    id: 'double',
    title: '🎩 Teach a trick',
    task: 'Teach Robo a trick called double that gives back a number times 2. Then show double(21).',
    starter: 'def double(n):\n    return n\n\nprint(double(21))\n',
    hint: 'The trick should give back n * 2.',
    check: (s, out) => uses(s, /\bdef\s+double\b/, 'a trick called double') ?? expectLines(out, ['42']),
  },
];
