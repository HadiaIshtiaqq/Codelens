// "New idea" cards for Kids mode: shown the first time a programming idea appears in a run.

export interface Concept {
  emoji: string;
  title: string;
  text: string;
  example: string;
}

export const CONCEPTS: Record<string, Concept> = {
  variable: {
    emoji: '📦',
    title: 'A box with a name',
    text: 'A variable is like a box with a label on it. You can put a number or some words inside, and look at it again later.',
    example: 'age = 8',
  },
  math: {
    emoji: '➕',
    title: 'Doing math',
    text: 'Computers are super fast at math! + adds, - takes away, * multiplies and / divides.',
    example: 'cookies = 3 + 4',
  },
  print: {
    emoji: '🗣️',
    title: 'Saying things',
    text: 'print( ) shows words or numbers on the screen. Words go inside quotes " ".',
    example: 'print("Hello!")',
  },
  input: {
    emoji: '❓',
    title: 'Asking you a question',
    text: 'input( ) asks a question and waits for your answer. Type your answers in the box under the code.',
    example: 'name = input("What is your name? ")',
  },
  list: {
    emoji: '🚂',
    title: 'A train of things',
    text: 'A list keeps many things in order, like cars in a train. Careful: the first car is number 0, not 1!',
    example: 'pets = ["cat", "dog"]',
  },
  'for-loop': {
    emoji: '🔁',
    title: 'Doing it again (for loop)',
    text: 'A loop repeats some steps. "for pet in pets" means: do the steps once for every pet in the train.',
    example: 'for pet in pets:\n    print(pet)',
  },
  'while-loop': {
    emoji: '🔂',
    title: 'Keep going while… (while loop)',
    text: 'A while loop asks a question again and again. As long as the answer is yes, it repeats. When it is no, it stops.',
    example: 'while count > 0:\n    count = count - 1',
  },
  if: {
    emoji: '🤔',
    title: 'Asking a question (if)',
    text: 'if lets the program choose. If the answer is yes, it does the steps inside. If the answer is no, it skips them.',
    example: 'if age > 7:\n    print("You can ride!")',
  },
  function: {
    emoji: '🎓',
    title: 'Teaching a trick (def)',
    text: 'def teaches Robo a new trick with a name. The trick does NOT run yet, only later when you ask for it.',
    example: 'def double(n):\n    return n * 2',
  },
  'function-call': {
    emoji: '🎩',
    title: 'Doing a trick',
    text: 'When you write a trick\'s name with ( ) after it, the trick runs. Things inside ( ) are what you give the trick.',
    example: 'double(4)',
  },
  call: {
    emoji: '🎩',
    title: 'Doing a trick',
    text: 'When you write a trick\'s name with ( ) after it, that trick runs.',
    example: 'pets.append("fish")',
  },
  return: {
    emoji: '🎁',
    title: 'Giving back an answer',
    text: 'return is how a trick hands its answer back to whoever asked for it.',
    example: 'return n * 2',
  },
  dictionary: {
    emoji: '📒',
    title: 'A label book',
    text: 'A dictionary keeps things with labels, like a book where you look up a name to find a number.',
    example: 'ages = {"Mia": 8}',
  },
  class: {
    emoji: '🏗️',
    title: 'A blueprint',
    text: 'A class is a blueprint for building your own kind of thing, like a plan for building many toy robots.',
    example: 'class Robot:\n    ...',
  },
  import: {
    emoji: '🧰',
    title: 'Extra tools',
    text: 'import gets a toolbox of extra tricks that someone already made, so you can use them.',
    example: 'import random',
  },
  error: {
    emoji: '💥',
    title: 'Oops, a bug!',
    text: 'A bug is a mistake in the code. Every coder makes them, even experts! Finding and fixing bugs is part of the fun.',
    example: 'print(10 / 0)',
  },
};
