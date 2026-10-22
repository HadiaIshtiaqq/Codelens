export interface Example {
  id: string;
  title: string;
  source: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'divide',
    title: 'ZeroDivisionError',
    source: `def divide(a, b):
    return a / b


for divisor in [4, 2, 0]:
    print("10 /", divisor, "=", divide(10, divisor))
`,
  },
  {
    id: 'average',
    title: 'Off-by-one (IndexError)',
    source: `def average(scores):
    total = 0
    for i in range(len(scores) + 1):
        total += scores[i]
    return total / len(scores)


grades = [90, 72, 85]
print("Average:", average(grades))
`,
  },
  {
    id: 'concat',
    title: 'TypeError (str + int)',
    source: `def describe(name, age):
    return name + " is " + age + " years old"


print(describe("Ada", 36))
`,
  },
  {
    id: 'inventory',
    title: 'KeyError',
    source: `inventory = {"apples": 5, "pears": 2}


def restock(item, amount):
    inventory[item] = inventory[item] + amount
    return inventory[item]


print(restock("apples", 3))
print(restock("plums", 4))
`,
  },
  {
    id: 'factorial',
    title: 'Recursion (works)',
    source: `def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)


for k in range(1, 6):
    print(k, factorial(k))
`,
  },
  {
    id: 'bubble',
    title: 'Bubble sort (works)',
    source: `def bubble_sort(items):
    data = list(items)
    for end in range(len(data) - 1, 0, -1):
        for i in range(end):
            if data[i] > data[i + 1]:
                data[i], data[i + 1] = data[i + 1], data[i]
    return data


print(bubble_sort([5, 1, 4, 2, 8]))
`,
  },
  {
    id: 'loop',
    title: 'Infinite loop (timeout)',
    source: `count = 10
while count > 0:
    count += 1
`,
  },
];
