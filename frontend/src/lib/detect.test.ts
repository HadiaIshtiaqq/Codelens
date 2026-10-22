import { describe, expect, it } from 'vitest';
import { detectNonPython } from './detect';

describe('detectNonPython', () => {
  it('recognises common languages', () => {
    expect(detectNonPython('function f(a) {\n  return a;\n}\nconsole.log(f(1));')).toBe('JavaScript');
    expect(detectNonPython('public class A { public static void main(String[] a) { System.out.println(1); } }')).toBe('Java');
    expect(detectNonPython('#include <iostream>\nint main() { std::cout << 1; }')).toBe('C++');
    expect(detectNonPython('fn main() {\n    let mut x = 1;\n    println!("{}", x);\n}')).toBe('Rust');
    expect(detectNonPython('package main\nimport "fmt"\nfunc main() { fmt.Println(1) }')).toBe('Go');
  });
  it('does not flag Python', () => {
    expect(detectNonPython('def f(a):\n    return a\n\nprint(f(1))\n')).toBeNull();
  });
});
