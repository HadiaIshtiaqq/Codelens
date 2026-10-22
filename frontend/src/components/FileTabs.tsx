import { useState } from 'react';
import { MAIN_FILE, type Debugger } from '../hooks/useDebugger';

/** Project files: main.py plus up to 10 modules that main.py can import. */
export function FileTabs({ dbg, runningFile }: { dbg: Debugger; runningFile: string | null }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const names = [MAIN_FILE, ...Object.keys(dbg.files)];

  const submit = () => {
    const problem = dbg.addFile(name);
    if (problem) {
      setError(problem);
      return;
    }
    setAdding(false);
    setName('');
    setError(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-slate-800 bg-slate-950/60 px-2 pt-1" role="tablist" aria-label="Project files">
      {names.map((file) => (
        <div key={file} className="flex items-center">
          <button
            role="tab"
            aria-selected={dbg.activeFile === file}
            className="tab flex items-center gap-1 py-1 font-mono text-xs"
            onClick={() => dbg.setActiveFile(file)}
            title={runningFile === file ? 'The robot is in this file' : file}
          >
            {runningFile === file && <span aria-label="current step is in this file">🤖</span>}
            {file}
          </button>
          {file !== MAIN_FILE && (
            <button
              className="px-1 text-xs text-slate-500 hover:text-red-300"
              onClick={() => dbg.removeFile(file)}
              aria-label={`Delete ${file}`}
              title={`Delete ${file}`}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {adding ? (
        <form
          className="flex items-center gap-1 py-0.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            autoFocus
            className="input w-32 py-0.5 font-mono text-xs"
            placeholder="utils.py"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
            aria-label="New file name"
          />
          <button className="btn px-2 py-0.5 text-xs">Add</button>
          {error && <span className="text-xs text-orange-300">{error}</span>}
        </form>
      ) : (
        <button
          className="px-2 py-1 text-xs text-slate-400 hover:text-slate-100"
          onClick={() => setAdding(true)}
          title="Add a module that main.py can import"
          disabled={Object.keys(dbg.files).length >= 10}
        >
          ＋ file
        </button>
      )}
    </div>
  );
}
