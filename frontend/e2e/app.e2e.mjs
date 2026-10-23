// End-to-end browser tests for the CodeLens workspace.
//
//   1. Start the app (API + built UI):   scripts/start.ps1  (or uvicorn, see README)
//   2. Run:                              npm run e2e
//
// Env: E2E_BASE_URL (default http://127.0.0.1:8000), CHROME_PATH (a Chrome/Chromium binary),
//      E2E_OUT (screenshot folder, default e2e/screenshots).
// Exits non-zero if any check fails, so CI can gate on it.
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const BASE = (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
const OUT = process.env.E2E_OUT ?? fileURLToPath(new URL('./screenshots/', import.meta.url));
const CHROME =
  process.env.CHROME_PATH ??
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
    (p) => existsSync(p),
  );
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
let failures = 0;
// Record what is sent to the speech engine (headless Chrome has no audio to check).
await page.addInitScript(() => {
  window.__spoken = [];
  if (!window.speechSynthesis) return;
  window.speechSynthesis.speak = (u) => {
    window.__spoken.push(u.text);
    setTimeout(() => u.onend && u.onend(new Event('end')), 50);
  };
});
const spoken = () => page.evaluate(() => window.__spoken.slice());
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('401') && errors.push(`console: ${m.text()}`));

async function check(name, fn) {
  try {
    await fn();
    console.log('OK  ', name);
  } catch (e) {
    failures++;
    console.log('FAIL', name, '-', e.message.split('\n')[0]);
    await page.screenshot({ path: `${OUT}/fail-${name.replace(/\W+/g, '_')}.png` }).catch(() => {});
  }
}

/** Open the app with `source` as main.py (via a share link, so Monaco auto-indent can't interfere). */
async function load(source, mode = 'game') {
  const enc = Buffer.from(source, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await page.goto(`${BASE}/`);
  await page.evaluate((m) => {
    localStorage.clear();
    localStorage.setItem('codelens.view-mode', m);
    localStorage.setItem('codelens.kids.pace', 'manual'); // checks step by hand unless they test auto-play
    localStorage.setItem('codelens.game.board', 'arrows'); // the arrow board checks; the cards board has its own
  }, mode);
  await page.goto(`${BASE}/#code=${enc}`);
  await page.reload();
  await page.waitForSelector('.monaco-editor', { timeout: 30000 });
}

const run = () => page.getByRole('button', { name: /Run Code/ }).click();
const status = (text) => page.getByRole('status').filter({ hasText: text }).waitFor({ timeout: 30000 });
// The game view's badge above the board: "LINE 17", or "LINE 3 · geometry.py" in another file.
const banner = async () => (await page.getByText(/^LINE \d+/).first().innerText()).toLowerCase();

const PROGRAM = `class Node:
    def __init__(self, value):
        self.value = value
        self.next = None


scores = [90, 72, 85]
alias = scores
info = {"name": "Ada", "scores": scores}
head = Node(1)
head.next = Node(2)


def average(xs):
    total = 0
    for i in range(len(xs) + 1):
        total += xs[i]
    return total / len(xs)


print("start")
print(average(scores))
`;

// ---------------------------------------------------------------- kids view (default for new visitors)
const says = () => page.locator('#robo-sentence').innerText();
await page.goto(`${BASE}/`);
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('codelens.kids.pace', 'manual');
});
await page.reload();
await check('kids view is the default', () => page.locator('[role="radio"][aria-checked="true"]', { hasText: 'Kids' }).waitFor({ timeout: 30000 }));
await check('kids: plain-word steps, idea cards, boxes', async () => {
  await page.getByLabel('Pick a program').selectOption('pets');
  await page.getByRole('checkbox', { name: /Read aloud/ }).uncheck().catch(() => {});
  await page.getByRole('button', { name: '▶ Start' }).click();
  await page.getByText(/Step 1 of \d+/).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /Next step/ }).click();
  if ((await spoken()).length) throw new Error(`spoke before the speaker was switched on: ${JSON.stringify(await spoken())}`);
  if (!(await says()).includes('Make a train called pets with 3 cars: “cat”, “dog” and “fish”')) throw new Error(await says());
  await page.getByText('💡 New idea: A train of things').waitFor();
  await page.locator('text=car 0').first().waitFor(); // the board shows the result of the step
});
await check('kids: plan of the program before starting', async () => {
  await page.getByLabel('Pick a program').selectOption('weather');
  await page.getByText('📖 What does this program do?').waitFor();
  await page.getByText('This program has 2 main steps').waitFor({ timeout: 10000 });
  await page.getByText(/Ask a question: is the temperature box bigger than 30\?|Ask a question: is the temperature box bigger than 25\?/).first().waitFor();
  await page.getByText('Otherwise (if the answer was no), do the lines below it.').first().waitFor();
});
await check('kids: hover a line or word to see what it means', async () => {
  // Monaco only shows hovers over the text itself, so point near the start of the line.
  const box = await page.locator('.monaco-editor .view-line', { hasText: 'temperature = 30' }).first().boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 5 });
  await page.locator('.monaco-hover', { hasText: 'Line 1' }).first().waitFor({ timeout: 8000 });
  await page.mouse.move(5, 5);
  await page.locator('.monaco-editor .view-line span', { hasText: /^if$/ }).first().hover();
  await page.locator('.monaco-hover', { hasText: 'asks a yes/no question' }).first().waitFor({ timeout: 8000 });
  await page.mouse.move(5, 5);
});
await check('kids: explain every line before running', async () => {
  await page.getByRole('button', { name: /Explain every line/ }).click();
  await page.locator('.cl-line-note', { hasText: 'Put 30 into' }).first().waitFor();
  await page.getByRole('button', { name: /Hide line notes/ }).click();
});
await page.screenshot({ path: `${OUT}/0-kids-plan.png` });
await check('kids: reads aloud using the name Robo', async () => {
  await page.getByRole('button', { name: '▶ Start' }).click();
  await page.getByText(/Step 1 of \d+/).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /Next step/ }).click();
  await page.getByRole('checkbox', { name: /Read aloud/ }).check();
  await page.getByRole('button', { name: /From the start/ }).click();
  const said = await spoken();
  if (!said.some((t) => t.startsWith("Hi, I'm Robo!"))) throw new Error(JSON.stringify(said.slice(-3)));
  if (said.some((t) => /the robot/i.test(t))) throw new Error('still says "the robot"');
  await page.getByRole('checkbox', { name: /Read aloud/ }).uncheck();
});
await check('kids: Start plays the steps by itself', async () => {
  await page.getByLabel('Pick a program').selectOption('pets');
  await page.getByLabel('How fast Robo goes').selectOption('fast');
  await page.getByRole('button', { name: '▶ Start' }).click();
  await page.getByText(/Step 3 of \d+/).waitFor({ timeout: 30000 }); // no Next presses
  await page.getByRole('button', { name: /Pause/ }).click();
  const paused = await page.getByText(/Step \d+ of \d+/).first().innerText();
  await page.waitForTimeout(2000);
  if ((await page.getByText(/Step \d+ of \d+/).first().innerText()) !== paused) throw new Error('kept going after Pause');
  await page.getByLabel('How fast Robo goes').selectOption('manual');
});
await check('kids: progress track and arrow keys move Robo', async () => {
  await page.getByLabel("Robo's place in the program").fill('0');
  await page.getByText(/Step 1 of \d+/).waitFor();
  await page.locator('#robo-sentence').click(); // focus the page, not a control
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.getByText(/Step 3 of \d+/).waitFor();
  await page.keyboard.press('ArrowLeft');
  await page.getByText(/Step 2 of \d+/).waitFor();
});
await check('kids: the turtle draws step by step', async () => {
  await page.getByLabel('Pick a program').selectOption('square');
  await page.getByRole('button', { name: '▶ Start' }).click();
  await page.getByText(/Step 1 of \d+/).waitFor({ timeout: 30000 });
  await page.getByTestId('turtle-stage').waitFor();
  for (let i = 0; i < 10 && !(await says()).includes('🐢 Walk forward 120 steps'); i++) await page.getByRole('button', { name: /Next step/ }).click();
  await page.getByText(/· 1 marks/).waitFor(); // the stage shows what the step does: the first side of the square
});
await check('kids: gentle oops', async () => {
  await page.getByLabel('Pick a program').selectOption('bug');
  await page.getByRole('button', { name: '▶ Start' }).click();
  await page.getByText(/sharing cookies among 0 friends/).waitFor({ timeout: 30000 });
});
await check('kids: help me fix a typing slip', async () => {
  await load('for i in range(3)\n    print(i)\n', 'kids');
  await page.getByRole('button', { name: '▶ Start' }).click();
  await page.getByRole('button', { name: /Help me fix it/ }).click({ timeout: 30000 });
  await page.getByText(/needs a ':' at the end/).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /Use this fix/ }).click();
  await page.getByText(/Step 1 of \d+/).waitFor({ timeout: 30000 });
  const first = (await page.locator('.monaco-editor .view-line').first().innerText()).replace(/ /g, ' ').trim(); // Monaco renders spaces as nbsp
  if (first !== 'for i in range(3):') throw new Error(`fix not applied: ${first}`);
});
await check('kids: complete a challenge and earn a star', async () => {
  await page.getByRole('button', { name: /Challenges/ }).click();
  await page.getByRole('button', { name: /Say hello/ }).click();
  await page.getByText('🎯 Mission: 👋 Say hello').waitFor();
  await page.getByRole('button', { name: '▶ Start' }).click();
  await page.getByText(/Not yet:/).waitFor({ timeout: 30000 });
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('print("Hello, world!")');
  await page.getByRole('button', { name: '▶ Start' }).click();
  await page.getByText('⭐ Mission complete! Great coding!').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /Challenges.*1\/8/ }).waitFor();
});
await check('kids: build a program with blocks', async () => {
  await page.getByRole('button', { name: /stop mission/ }).click();
  await page.getByRole('button', { name: /Use blocks/ }).click();
  await page.locator('.blocklySvg').first().waitFor({ timeout: 20000 });
  await page.locator('.monaco-editor .view-line', { hasText: 'for count in range(3):' }).first().waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: '▶ Start' }).click();
  await page.getByText(/Step 1 of \d+/).waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${OUT}/0-kids-blocks.png` });
  await page.getByRole('button', { name: /Type code/ }).click();
});
await page.screenshot({ path: `${OUT}/0-kids.png` });

// ---------------------------------------------------------------- game view
await load(PROGRAM);
await check('game view', () => page.locator('[role="radio"][aria-checked="true"]', { hasText: 'Game' }).waitFor());
await check('run lands on the crash', async () => {
  await run();
  await status('IndexError');
  await page.getByText(/💥 IndexError: list index out of range/).first().waitFor();
});
await check('board: frames, objects, arrows, aliasing', async () => {
  await page.getByText('Frames · where the robot is').waitFor();
  if ((await page.locator('svg path.cl-draw').count()) < 3) throw new Error('too few arrows');
  await page.getByText(/shared by .*scores/).first().waitFor();
});
await check('game: cards board writes each variable out', async () => {
  await page.getByRole('radio', { name: /Cards/ }).click();
  const cards = page.getByTestId('cards-board');
  await cards.getByText(/Inside average\(\)/).waitFor();
  await cards.locator('[data-var="xs"]').waitFor();
  await cards.locator('[data-var="xs"]').getByText(/same object as scores/).waitFor(); // aliasing across frames
  await page.getByRole('radio', { name: /Arrows/ }).click();
  await page.getByText('Frames · where the robot is').waitFor();
});
await check('screen-reader description of the board', async () => {
  const text = await page.locator('p.sr-only').first().innerText();
  if (!text.includes('average') || !text.includes('the same object as')) throw new Error(text);
});
await check('one-line explanation beside the board, and beside the line in Classic', async () => {
  const note = await page.locator('p', { hasText: /^🗣 / }).first().innerText();
  if (!note.includes('Crash!')) throw new Error(note);
  await page.getByRole('radio', { name: /Classic/ }).click();
  await page.locator('.cl-inline-note').first().waitFor();
  await page.getByRole('radio', { name: /Game/ }).click();
});
await page.screenshot({ path: `${OUT}/1-crash.png` });
await check('game: read aloud speaks each step', async () => {
  await page.getByRole('button', { name: /Read aloud/ }).click();
  const before = (await spoken()).length;
  await page.keyboard.press('Alt+Home');
  await page.keyboard.press('F10');
  await page.waitForTimeout(300);
  const said = (await spoken()).slice(before);
  if (!said.length || !said.some((t) => t.length > 5)) throw new Error(JSON.stringify(said));
  await page.getByRole('button', { name: /Reading aloud/ }).click();
  await page.keyboard.press('Alt+E');
});
await check('game: program plan panel', async () => {
  await page.getByRole('button', { name: /What does this program do/ }).click();
  await page.getByText(/This program has \d+ main steps and teaches 1 trick \(average\)/).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: /What does this program do/ }).click();
});
await check('explain every line', async () => {
  await page.getByRole('button', { name: /Explain every line/ }).click();
  await page.locator('.cl-line-note').first().waitFor();
  await page.getByRole('button', { name: /Explain every line/ }).click();
});
await check('breakpoints + continue', async () => {
  await page.locator('.monaco-editor .line-numbers', { hasText: /^17$/ }).first().click();
  await page.locator('.cl-bp').first().waitFor();
  await page.keyboard.press('Alt+Home');
  await page.getByRole('button', { name: /Continue/ }).click();
  if (!(await banner()).includes('line 17')) throw new Error(await banner());
  await page.getByRole('button', { name: 'Clear all breakpoints' }).click();
});
await check('game over, replay and autoplay', async () => {
  await page.keyboard.press('Alt+End');
  await page.getByText('GAME OVER').waitFor();
  await page.getByRole('button', { name: '↺ Replay' }).click();
  await page.getByLabel('Playback speed').selectOption({ label: '⚡ 4×' });
  await page.getByRole('button', { name: '▶ Play' }).click();
  await page.waitForTimeout(1500);
  if (Number(await page.locator('#step-slider').inputValue()) < 5) throw new Error('autoplay did not advance');
  await page.getByRole('button', { name: /Pause/ }).click().catch(() => {});
});
await check('predict mode', async () => {
  await page.keyboard.press('Alt+Home');
  await page.getByRole('button', { name: /Predict mode OFF/ }).click();
  await page.keyboard.press('F10');
  await page.getByText(/Where will the robot go next/).waitFor();
  await page.locator('.monaco-editor .view-line').nth(0).click();
  await page.getByText(/Correct!|Not quite/).first().waitFor();
  await page.getByRole('button', { name: /Predict mode ON/ }).click();
});
await check('generated tests from the run', async () => {
  await page.getByRole('button', { name: /AI coach/ }).click();
  await page.getByRole('tab', { name: /Test Results/ }).click();
  await page.locator('.monaco-editor', { hasText: 'Generated from your last run' }).first().waitFor({ timeout: 10000 });
  await page.locator('.monaco-editor', { hasText: 'def test_average_does_not_crash' }).first().waitFor();
});

// ---------------------------------------------------------------- input(), files, long runs
await check('program input feeds input()', async () => {
  await load("name = input('Name? ')\nage = int(input())\nprint(name, age + 1)\n");
  await page.getByRole('textbox', { name: /Program input/ }).fill('Ada\n36\n');
  await run();
  await status('EXIT 0');
  await page.getByRole('tab', { name: 'Full stdout' }).click();
  await page.getByRole('log').filter({ hasText: 'Ada 37' }).first().waitFor();
});
await check('multi-file project: the robot follows into the module', async () => {
  await load('from geometry import area\nprint(area(2))\n');
  await page.getByRole('button', { name: '＋ file' }).click();
  await page.getByLabel('New file name').fill('geometry');
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('tab', { name: 'geometry.py' }).waitFor();
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('def area(r): return 3 * r * r\n');
  await run();
  await status('EXIT 0');
  await page.getByRole('tab', { name: 'Full stdout' }).click();
  await page.getByRole('log').filter({ hasText: '12' }).first().waitFor();
  for (let i = 0; i < 30 && !(await banner()).includes('geometry.py'); i++) await page.keyboard.press('F10');
  if (!(await banner()).includes('· geometry.py')) throw new Error(await banner());
  await page.locator('[role="tab"][aria-selected="true"]', { hasText: 'geometry.py' }).waitFor();
});
await page.screenshot({ path: `${OUT}/2-multifile.png` });
await check('long run keeps the ending and marks the gap', async () => {
  await load('data = list(range(10))\nfor n in range(300000):\n    total = n\nprint(data[total])\n');
  await run();
  await status('IndexError');
  await page.getByText(/middle steps skipped|recording paused/).first().waitFor();
  await page.getByRole('radio', { name: /Classic/ }).click();
  await page.getByText(/steps skipped|line recording paused/).first().waitFor();
  await page.getByRole('radio', { name: /Game/ }).click();
});
await check('game: a big board shrinks to fit the panel', async () => {
  const rooms = ['Home', 'School', 'Market', 'Park', 'Mall', 'Hospital', 'Zoo', 'Library', 'Pool', 'Farm', 'Beach', 'Museum', 'Cafe', 'Bank', 'Gym', 'Station'];
  const graph = rooms.map((r, i) => `    '${r}': {'${rooms[(i + 1) % rooms.length]}': ${i + 1}},`).join('\n');
  await load(`graph = {\n${graph}\n}\nfor place in graph:\n    print(place)\n`);
  await run();
  await status('EXIT 0');
  await page.getByTitle('Last step (Alt+End)').click(); // every box exists by the end
  await page.getByRole('button', { name: 'Keep exploring' }).click();
  await page.getByRole('button', { name: /\d+% · full size/ }).waitFor();
  const overflow = () =>
    page.getByText('Frames · where the robot is').evaluate((el) => {
      const v = el.closest('.overflow-auto'); // the board's scrolling area
      return Math.max(v.scrollHeight - v.clientHeight, v.scrollWidth - v.clientWidth);
    });
  if ((await overflow()) > 2) throw new Error(`board still scrolls by ${await overflow()}px`);
  await page.getByRole('button', { name: /full size/ }).click();
  if ((await overflow()) <= 2) throw new Error('full size should be bigger than the panel');
  await page.getByRole('button', { name: /Fit to screen/ }).click();
});
await check('delete run', async () => {
  await page.getByRole('button', { name: /delete run/ }).click();
  await page.getByRole('status').filter({ hasText: 'IDLE' }).waitFor();
});

// ---------------------------------------------------------------- other tabs and layouts
await check('code converter tab loads', async () => {
  await page.getByRole('tab', { name: /Code Converter/ }).click();
  await page.getByText(/Paste code in any language|AI is offline/).first().waitFor();
  await page.getByRole('tab', { name: /Python Debugger/ }).click();
});
await check('Alexa+ simulator answers through the MCP server', async () => {
  await load('def total(xs):\n    s = 0\n    for i in range(len(xs) + 1):\n        s += xs[i]\n    return s\n\nprint(total([1, 2, 3]))\n');
  await page.getByRole('tab', { name: /Alexa/ }).click();
  await page.getByText(/MCP connected · \d+ tools/).waitFor({ timeout: 20000 });
  const ask = async (text, expected) => {
    await page.getByLabel('Say something to Alexa').fill(text);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.getByText(expected).first().waitFor({ timeout: 30000 });
  };
  await ask('Alexa, run my code', /crashed with an IndexError on line 4/);
  await ask('fix it', /I have a fix/);
  await ask('test the fix', /apply the fix/);
  await ask('apply the fix', /put the fixed code in your editor/);
  const log = await page.getByTestId('mcp-log').innerText();
  for (const method of ['initialize', 'tools/list', 'tools/call']) if (!log.includes(method)) throw new Error(`missing ${method} in the MCP log`);
  await page.getByRole('tab', { name: /Python Debugger/ }).click();
  await page.getByRole('radio', { name: /Game/ }).click();
});
await check('classic view', async () => {
  await page.getByRole('radio', { name: /Classic/ }).click();
  await page.getByText('Timeline').first().waitFor();
  await page.getByRole('radio', { name: /Game/ }).click();
});
await check('phone-width layout stacks the board', async () => {
  await page.setViewportSize({ width: 400, height: 860 });
  await load('xs = [1, 2]\nys = xs\n');
  await run();
  await status('EXIT 0');
  const frames = await page.getByText('Frames · where the robot is').boundingBox();
  const objects = await page.getByText('Objects · what they point at').boundingBox();
  if (!frames || !objects || objects.y <= frames.y) throw new Error('board not stacked vertically');
  await page.screenshot({ path: `${OUT}/3-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1600, height: 1000 });
});

if (errors.length) {
  failures++;
  console.log(`BROWSER ERRORS:\n${errors.join('\n')}`);
} else {
  console.log('no browser errors');
}
await browser.close();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
