// Short first programs for young beginners, roughly in the order a child would meet the ideas.

export interface KidExample {
  id: string;
  title: string;
  source: string;
  stdin?: string;
}

export const KID_EXAMPLES: KidExample[] = [
  { id: 'hello', title: '👋 Hello, robot!', source: 'print("Hello!")\nname = "Mia"\nprint("Hi", name)\n' },
  {
    id: 'apples',
    title: '🍎 Counting apples',
    source: 'apples = 3\napples = apples + 2\nprint("I have", apples, "apples")\n',
  },
  { id: 'count', title: '🔢 Count to 5', source: 'for number in range(1, 6):\n    print(number)\n' },
  {
    id: 'weather',
    title: '☀️ Is it hot?',
    source: 'temperature = 30\nif temperature > 25:\n    print("It is hot! Wear a hat.")\nelse:\n    print("Bring a jacket.")\n',
  },
  {
    id: 'pets',
    title: '🐶 My pets (a list)',
    source: 'pets = ["cat", "dog", "fish"]\nfor pet in pets:\n    print("I love my", pet)\n',
  },
  {
    id: 'times',
    title: '✖️ Times table',
    source: 'for n in range(1, 6):\n    print(n, "times 3 is", n * 3)\n',
  },
  {
    id: 'countdown',
    title: '🚀 Countdown',
    source: 'count = 3\nwhile count > 0:\n    print(count)\n    count = count - 1\nprint("Blast off!")\n',
  },
  {
    id: 'trick',
    title: '🎩 Teach a trick',
    source: 'def double(number):\n    return number * 2\n\nprint(double(4))\nprint(double(10))\n',
  },
  {
    id: 'name',
    title: '❓ What is your name?',
    source: 'name = input("What is your name? ")\nprint("Nice to meet you,", name)\n',
    stdin: 'Mia\n',
  },
  {
    id: 'square',
    title: '🐢 Draw a square',
    source: `import turtle

pen = turtle.Turtle()
pen.color("blue")
pen.pensize(4)
for side in range(4):
    pen.forward(120)
    pen.left(90)
`,
  },
  {
    id: 'star',
    title: '⭐ Draw a star',
    source:
      `import turtle

star = turtle.Turtle()
star.color("orange", "gold")
star.begin_fill()
for point in range(5):
    star.forward(150)
    star.right(144)
star.end_fill()
`,
  },
  {
    id: 'rainbow',
    title: '🌈 Rainbow spiral',
    source:
      `import turtle

turtle.bgcolor("black")
pen = turtle.Turtle()
colors = ["red", "orange", "yellow", "green", "blue", "purple"]
for size in range(36):
    pen.pencolor(colors[size % 6])
    pen.pensize(3)
    pen.forward(size * 5)
    pen.left(61)
`,
  },
  {
    id: 'bug',
    title: '🐞 Find the bug!',
    source: 'cookies = 12\nfriends = 0\nprint("Each friend gets", cookies / friends)\n',
  },
];
