import { getAccessCode } from '../api/client';

// A small Model Context Protocol client over Streamable HTTP: the same wire protocol
// Alexa+ uses to reach an MCP server. Every request and response is reported to `onLog`
// so the simulator can show the traffic.

export const MCP_PROTOCOL_VERSION = '2025-11-25';

export interface McpLogEntry {
  id: number;
  direction: 'request' | 'response' | 'error';
  method: string;
  summary: string;
  body: unknown;
  ms?: number;
  at: number;
}

export interface McpTool {
  name: string;
  description?: string;
}

type JsonRpcResponse = { jsonrpc: '2.0'; id?: number; result?: any; error?: { code: number; message: string } };

let logCounter = 0;

export class McpClient {
  private session: string | null = null;
  private protocol = MCP_PROTOCOL_VERSION;
  private nextId = 1;
  private connecting: Promise<void> | null = null;
  serverName = '';
  tools: McpTool[] = [];

  constructor(
    private readonly url: string,
    private readonly onLog: (entry: McpLogEntry) => void = () => {},
  ) {}

  get sessionId() {
    return this.session;
  }

  get protocolVersion() {
    return this.protocol;
  }

  private log(direction: McpLogEntry['direction'], method: string, summary: string, body: unknown, ms?: number) {
    this.onLog({ id: ++logCounter, direction, method, summary, body, ms, at: Date.now() });
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.session) {
      h['Mcp-Session-Id'] = this.session;
      h['MCP-Protocol-Version'] = this.protocol;
    }
    const code = getAccessCode();
    if (code) h['X-CodeLens-Access'] = code;
    return h;
  }

  /** POST one JSON-RPC message; returns the matching response (JSON or a server-sent event). */
  private async send(message: Record<string, unknown>, summary: string): Promise<{ reply: JsonRpcResponse | null; res: Response }> {
    const method = String(message.method);
    this.log('request', method, summary, message);
    const started = performance.now();
    const res = await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(message) });
    const ms = Math.round(performance.now() - started);
    if (!res.ok && res.status !== 202) {
      const text = await res.text();
      this.log('error', method, `HTTP ${res.status}`, text, ms);
      throw Object.assign(new Error(`MCP ${method} failed: HTTP ${res.status}`), { status: res.status });
    }
    if (!('id' in message) || res.status === 202) {
      this.log('response', method, `${res.status} accepted`, null, ms);
      return { reply: null, res };
    }
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    let reply: JsonRpcResponse | null = null;
    if (type.includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (!data) continue;
        const parsed = JSON.parse(data) as JsonRpcResponse;
        if (parsed.id === message.id) reply = parsed;
      }
    } else if (text) {
      reply = JSON.parse(text) as JsonRpcResponse;
    }
    if (!reply) throw new Error(`MCP ${method}: no response`);
    if (reply.error) {
      this.log('error', method, reply.error.message, reply, ms);
      throw new Error(reply.error.message);
    }
    this.log('response', method, `${type.includes('event-stream') ? 'SSE' : 'JSON'} · ${ms} ms`, reply, ms);
    return { reply, res };
  }

  async connect(): Promise<void> {
    if (this.session) return;
    this.connecting ??= (async () => {
      const { reply, res } = await this.send(
        {
          jsonrpc: '2.0',
          id: this.nextId++,
          method: 'initialize',
          params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'codelens-alexa-simulator', version: '1.0.0' } },
        },
        `protocol ${MCP_PROTOCOL_VERSION}`,
      );
      this.session = res.headers.get('mcp-session-id');
      this.protocol = reply?.result?.protocolVersion ?? MCP_PROTOCOL_VERSION;
      this.serverName = reply?.result?.serverInfo?.title ?? reply?.result?.serverInfo?.name ?? 'MCP server';
      await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'ready');
      const tools = await this.send({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list' }, 'what can you do?');
      this.tools = tools.reply?.result?.tools ?? [];
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Call a tool and return its structured result (the server's `speech` tools return {speech, ...}). */
  async callTool<T = Record<string, any>>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.connect();
    const call = () => this.send({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } }, name);
    let out;
    try {
      out = await call();
    } catch (err) {
      // Sessions expire on the server (idle timeout or restart): start a new one once.
      if ((err as { status?: number }).status !== 404) throw err;
      this.session = null;
      await this.connect();
      out = await call();
    }
    const result = out.reply?.result;
    const text = result?.content?.find((c: { type: string }) => c.type === 'text')?.text;
    if (result?.isError) throw new Error(text || `${name} failed`);
    if (result?.structuredContent) {
      const sc = result.structuredContent;
      return (sc.result && Object.keys(sc).length === 1 ? sc.result : sc) as T;
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
