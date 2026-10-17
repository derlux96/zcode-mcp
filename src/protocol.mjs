import { readFileSync } from 'node:fs';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_VERSION = '2025-06-18';
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const DEFAULT_SERVER_INFO = { name: 'zcode-delegate', version: PACKAGE_VERSION };

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function negotiateVersion(params) {
  const requested = params && params.protocolVersion;
  return SUPPORTED_VERSIONS.includes(requested) ? requested : DEFAULT_VERSION;
}

export function createProtocol({ tools = [], serverInfo = DEFAULT_SERVER_INFO } = {}) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  // In-flight tools/call requests by id; notifications/cancelled aborts one.
  const inFlight = new Map();

  async function callTool(id, params) {
    const tool = byName.get(params && params.name);
    if (!tool) return fail(id, INVALID_PARAMS, `Unknown tool: ${params && params.name}`);
    const ctl = new AbortController();
    inFlight.set(id, ctl);
    try {
      const result = await tool.handler((params && params.arguments) || {}, { signal: ctl.signal });
      // A cancelled request gets no response; one whose wait ended because the
      // input closed still answers (e.g. `echo ... | server` gets its job_id).
      return ctl.signal.aborted && !ctl.inputClosed ? null : ok(id, result);
    } catch (error) {
      // MCP: a cancelled request gets no response at all.
      if (ctl.signal.aborted) return null;
      throw error;
    } finally {
      if (inFlight.get(id) === ctl) inFlight.delete(id);
    }
  }

  return {
    // The client's input closed: end every in-flight wait now (the replies are
    // still written), so the server can exit instead of lingering up to wait_ms.
    abortAll() {
      for (const ctl of inFlight.values()) {
        ctl.inputClosed = true;
        ctl.abort();
      }
    },
    async handleMessage(msg) {
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
        return msg && msg.id !== undefined ? fail(msg.id, INVALID_REQUEST, 'Invalid Request') : null;
      }
      if (msg.id === undefined) { // notification: never answered
        if (msg.method === 'notifications/cancelled') {
          const ctl = inFlight.get(msg.params && msg.params.requestId);
          if (ctl) ctl.abort();
        }
        return null;
      }
      const { id, method, params } = msg;
      try {
        switch (method) {
          case 'initialize':
            return ok(id, {
              protocolVersion: negotiateVersion(params),
              capabilities: { tools: {} },
              serverInfo,
            });
          case 'ping':
            return ok(id, {});
          case 'tools/list':
            return ok(id, {
              tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
            });
          case 'tools/call':
            return await callTool(id, params);
          default:
            return fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
      } catch (error) {
        return fail(id, INTERNAL_ERROR, error && error.message ? error.message : String(error));
      }
    },
  };
}
