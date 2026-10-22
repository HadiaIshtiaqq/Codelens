#!/usr/bin/env node
// Cross-platform launcher for the CodeLens MCP server (used by .mcp.json / Claude Code).
// Finds the backend's virtualenv Python on Windows, macOS or Linux and runs the server over stdio.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venvPython = [
  path.join(root, 'backend', '.venv', 'Scripts', 'python.exe'),
  path.join(root, 'backend', '.venv', 'bin', 'python'),
].find((p) => existsSync(p));
const python = venvPython ?? (process.platform === 'win32' ? 'python' : 'python3');

const child = spawn(python, [path.join(root, 'backend', 'app', 'mcp_server.py'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { CODELENS_API_URL: 'http://127.0.0.1:8000', ...process.env },
});
child.on('exit', (code) => process.exit(code ?? 0));
