// Drag-and-drop coding with Blockly: snap blocks together instead of typing,
// and the blocks become real Python that Robo runs and explains.
import * as Blockly from 'blockly/core';
import 'blockly/blocks';
import * as En from 'blockly/msg/en';
import { pythonGenerator } from 'blockly/python';
import { useEffect, useRef } from 'react';

Blockly.setLocale(En as unknown as { [key: string]: string });

const SAVE_KEY = 'codelens.kids.blocks';

const TOOLBOX = {
  kind: 'categoryToolbox',
  contents: [
    {
      kind: 'category',
      name: '🗣 Show',
      colour: '160',
      contents: [
        { kind: 'block', type: 'text_print', inputs: { TEXT: { shadow: { type: 'text', fields: { TEXT: 'Hello!' } } } } },
        { kind: 'block', type: 'text' },
        { kind: 'block', type: 'text_join' },
      ],
    },
    { kind: 'category', name: '📦 Boxes', colour: '330', custom: 'VARIABLE' },
    {
      kind: 'category',
      name: '🔢 Numbers',
      colour: '230',
      contents: [
        { kind: 'block', type: 'math_number' },
        { kind: 'block', type: 'math_arithmetic' },
        { kind: 'block', type: 'math_random_int', inputs: { FROM: { shadow: { type: 'math_number', fields: { NUM: 1 } } }, TO: { shadow: { type: 'math_number', fields: { NUM: 6 } } } } },
      ],
    },
    {
      kind: 'category',
      name: '🤔 Questions',
      colour: '210',
      contents: [
        { kind: 'block', type: 'controls_if' },
        { kind: 'block', type: 'logic_compare' },
        { kind: 'block', type: 'logic_operation' },
        { kind: 'block', type: 'logic_boolean' },
      ],
    },
    {
      kind: 'category',
      name: '🔁 Loops',
      colour: '120',
      contents: [
        { kind: 'block', type: 'controls_repeat_ext', inputs: { TIMES: { shadow: { type: 'math_number', fields: { NUM: 3 } } } } },
        { kind: 'block', type: 'controls_for' },
        { kind: 'block', type: 'controls_forEach' },
        { kind: 'block', type: 'controls_whileUntil' },
      ],
    },
    {
      kind: 'category',
      name: '🚂 Lists',
      colour: '260',
      contents: [
        { kind: 'block', type: 'lists_create_with' },
        { kind: 'block', type: 'lists_length' },
        { kind: 'block', type: 'lists_getIndex' },
      ],
    },
    {
      kind: 'category',
      name: '❓ Ask',
      colour: '20',
      contents: [{ kind: 'block', type: 'text_prompt_ext', inputs: { TEXT: { shadow: { type: 'text', fields: { TEXT: 'What is your name?' } } } } }],
    },
    { kind: 'category', name: '🎓 Tricks', colour: '290', custom: 'PROCEDURE' },
  ],
};

/** A first program so the canvas isn't empty: say hello three times. */
const STARTER = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'controls_repeat_ext',
        x: 30,
        y: 30,
        inputs: {
          TIMES: { shadow: { type: 'math_number', fields: { NUM: 3 } } },
          DO: { block: { type: 'text_print', inputs: { TEXT: { shadow: { type: 'text', fields: { TEXT: 'Hello!' } } } } } },
        },
      },
    ],
  },
};

/** Blockly declares every variable as `x = None` up front; drop those lines when the variable is set later anyway. */
export function tidyGeneratedPython(code: string): string {
  const lines = code.split('\n');
  const declared = new Set<string>();
  let i = 0;
  while (i < lines.length && /^\w+ = None$/.test(lines[i])) declared.add(lines[i].split(' ')[0]), i++;
  const rest = lines.slice(i).join('\n').replace(/^\n+/, '');
  const keep = [...declared].filter((name) => !new RegExp(`^(\\s*)(${name} =|for ${name} in)`, 'm').test(rest));
  return (keep.map((n) => `${n} = None`).join('\n') + (keep.length ? '\n' : '') + rest).trimEnd() + '\n';
}

export function KidsBlocks({ onCode }: { onCode: (python: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    if (!host.current) return;
    const workspace = Blockly.inject(host.current, {
      toolbox: TOOLBOX,
      renderer: 'zelos', // big, rounded, Scratch-like blocks
      theme: Blockly.Themes.Classic,
      zoom: { controls: true, wheel: true, startScale: 0.9 },
      trashcan: true,
      move: { scrollbars: true, drag: true, wheel: false },
    });
    try {
      const saved = localStorage.getItem(SAVE_KEY);
      Blockly.serialization.workspaces.load(saved ? JSON.parse(saved) : STARTER, workspace);
    } catch {
      Blockly.serialization.workspaces.load(STARTER, workspace);
    }
    const update = (e?: Blockly.Events.Abstract) => {
      if (e && e.isUiEvent) return;
      onCodeRef.current(tidyGeneratedPython(pythonGenerator.workspaceToCode(workspace)));
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(Blockly.serialization.workspaces.save(workspace)));
      } catch {
        /* ignore */
      }
    };
    update();
    workspace.addChangeListener(update);
    const resize = new ResizeObserver(() => Blockly.svgResize(workspace));
    resize.observe(host.current);
    return () => {
      resize.disconnect();
      workspace.dispose();
    };
  }, []);

  return <div ref={host} className="h-full min-h-[340px] w-full" aria-label="Blocks editor: drag blocks from the left to build a program" />;
}
