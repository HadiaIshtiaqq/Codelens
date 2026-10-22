// Hover explanations: point at any line to see what it does, or at a Python word to learn what it means.
import { monaco } from './monaco';

/** What common Python words mean, in plain language. */
export const GLOSSARY: Record<string, string> = {
  print: '**print** shows words or numbers on the screen.',
  input: '**input** asks a question and waits for an answer (type answers in the input box).',
  for: '**for** repeats the indented lines once for each thing in a list or range.',
  in: '**in** means "inside": `for pet in pets` takes each pet from pets, one at a time.',
  range: '**range** makes counting numbers. `range(1, 6)` is 1, 2, 3, 4, 5 (it stops *before* 6).',
  if: '**if** asks a yes/no question. The indented lines run only when the answer is yes.',
  elif: '**elif** means "else if": ask another question when the one above was no.',
  else: '**else** means "otherwise": these lines run when the question above was no.',
  while: '**while** keeps repeating the indented lines as long as its question is yes.',
  def: '**def** teaches a new function (a trick) with a name. It runs later, when you call it.',
  return: '**return** hands an answer back from a function to whoever called it.',
  len: '**len** counts how many things are in something: `len([5, 6, 7])` is 3.',
  import: '**import** gets a toolbox of extra functions that someone else wrote.',
  from: '**from** picks tools out of a toolbox: `from math import sqrt`.',
  True: '**True** means yes.',
  False: '**False** means no.',
  None: '**None** means "nothing here".',
  and: '**and**: both questions must be yes.',
  or: '**or**: at least one question must be yes.',
  not: '**not** flips yes and no.',
  break: '**break** jumps out of a loop straight away.',
  continue: '**continue** skips to the next time around the loop.',
  pass: '**pass** means "do nothing" (a placeholder).',
  class: '**class** makes a blueprint for building your own kind of object.',
  int: '**int** turns something into a whole number: `int("7")` is 7.',
  str: '**str** turns something into text: `str(7)` is "7".',
  float: '**float** turns something into a number with a decimal point: `float("2.5")` is 2.5.',
  append: '**append** adds one thing to the end of a list.',
  sum: '**sum** adds up all the numbers in a list.',
  max: '**max** finds the biggest one.',
  min: '**min** finds the smallest one.',
  round: '**round** rounds a number: `round(2.6)` is 3.',
  self: '**self** is the object a method is working on.',
};

const notesByModel = new Map<string, Record<string, string>>();

/** Line notes for the editor model with this path (each file/editor has its own model). */
export function setHoverNotes(modelPath: string, notes: Record<string, string> | null) {
  if (notes) notesByModel.set(modelPath, notes);
  else notesByModel.delete(modelPath);
}

let registered = false;

export function registerHoverProvider() {
  if (registered) return;
  registered = true;
  monaco.languages.registerHoverProvider('python', {
    provideHover(model, position) {
      const parts: { value: string }[] = [];
      const word = model.getWordAtPosition(position);
      if (word && GLOSSARY[word.word]) parts.push({ value: `📘 ${GLOSSARY[word.word]}` });
      const notes = notesByModel.get(model.uri.path.replace(/^\//, ''));
      const note = notes?.[String(position.lineNumber)];
      if (note) parts.push({ value: `💡 **Line ${position.lineNumber}:** ${note}` });
      return parts.length ? { contents: parts } : null;
    },
  });
}
