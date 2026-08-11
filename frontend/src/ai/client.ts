import type { HistoryEntry, ToolResult } from './providers';
import { buildRequest, parseResponse } from './providers';

export type { HistoryEntry } from './providers';

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; toolName: string; toolUseId: string }
  | { type: 'tool_done'; toolUseId: string; result: string }
  | { type: 'rate_limited'; delaySeconds: number; attempt: number }
  | { type: 'done' }
  | { type: 'error'; message: string };

const MAX_TURNS = 10;
const MAX_RETRIES = 3;

function isToolGenerationFailure(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('failed to call a function') || m.includes('failed_generation');
}

// Groq validates Llama's tool call output server-side. When Llama puts JSON args inside the
// function name (e.g. 'add_wire {"type":"qubit"}'), Groq rejects it with this message.
// We catch it and downgrade from tool_choice:required → auto so tools remain available
// but Groq stops hard-validating the output format.
function isToolNameValidationError(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('not in request.tools') || m.includes('tool call validation failed');
}

const MAX_RETRY_DELAY_MS = 30_000; // never wait longer than 30s regardless of Retry-After

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const secs = parseInt(retryAfterHeader, 10);
    if (!isNaN(secs)) return Math.min(secs * 1000, MAX_RETRY_DELAY_MS);
  }
  // Exponential backoff: 5s, 10s, 20s — capped at 30s
  return Math.min(5000 * Math.pow(2, attempt), 30_000);
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  onRateLimit: (delaySecs: number, attempt: number) => void,
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 429 || attempt >= MAX_RETRIES) return response;

    const delay = retryDelayMs(attempt, response.headers.get('Retry-After'));
    onRateLimit(Math.round(delay / 1000), attempt + 1);
    await new Promise(r => setTimeout(r, delay));
  }
  // Never reached — loop always returns inside
  throw new Error('fetchWithRetry: unreachable');
}

export async function runAgentTurn(
  apiKey: string,
  modelId: string,
  baseUrl: string,
  apiFormat: 'openai' | 'anthropic',
  history: HistoryEntry[],
  onEvent: (event: StreamEvent) => void,
  handleToolCall: (name: string, input: Record<string, unknown>) => Promise<string>,
  useServerProxy = false,
  /**
   * Force a structured tool call on the first response. Only worth doing for build
   * requests — forcing it on "explain this circuit" burns a whole round-trip making the
   * model call read_circuit for data it was already handed in the snapshot.
   */
  forceFirstToolCall = false,
  /** Scopes the system prompt and tool list to what this request can actually do. */
  intent: 'build' | 'explain' | 'analyze' = 'build',
): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [...history];
  let withTools = true;
  let forceToolsDisabled = false; // set true when Groq rejects a forced tool call by name

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const forceTools = withTools && turn === 0 && forceFirstToolCall && !forceToolsDisabled;
    const { url, options } = buildRequest(apiKey, baseUrl, modelId, apiFormat, entries, withTools, forceTools, useServerProxy, intent);

    let response: Response;
    try {
      response = await fetchWithRetry(url, options, (delaySecs, attempt) => {
        onEvent({ type: 'rate_limited', delaySeconds: delaySecs, attempt });
      });
    } catch (e) {
      onEvent({ type: 'error', message: `Network error: ${e instanceof Error ? e.message : String(e)}` });
      return entries;
    }

    if (!response.ok) {
      const body = await response.text();
      let msg = `Error ${response.status}`;
      try {
        const parsed = JSON.parse(body);
        msg = parsed.error?.message ?? parsed.message ?? parsed.error ?? msg;
      } catch { /* ignore */ }

      // A 404 here almost always means the model id has been retired, not that the
      // endpoint or key is wrong — and the raw message rarely says so. Providers drop
      // model ids regularly, so point at the tool that lists the live ones.
      if (response.status === 404) {
        msg = `Model "${modelId}" was not found (404). This usually means the id has been ` +
          `retired by the provider. Run \`npm run ai:models\` with your API key to list the ` +
          `ids your key can currently use, then pick one of those. Original message: ${msg}`;
      }
      if (response.status === 401 || response.status === 403) {
        msg = `Authentication failed (${response.status}) — check the API key for this provider. Original message: ${msg}`;
      }
      if (withTools && isToolGenerationFailure(msg)) {
        withTools = false;
        continue;
      }
      // Groq/Llama puts JSON args in the function name → Groq rejects it.
      // Downgrade from tool_choice:required → auto and retry; tools stay available.
      if (isToolNameValidationError(msg)) {
        forceToolsDisabled = true;
        continue;
      }
      onEvent({ type: 'error', message: msg });
      return entries;
    }

    const data = await response.json();
    const { text, toolCalls, isToolUse } = parseResponse(data, apiFormat);

    entries.push({ kind: 'assistant', text, toolCalls });
    if (text) onEvent({ type: 'text', text });
    if (!isToolUse) break;

    const results: ToolResult[] = [];
    for (const tc of toolCalls) {
      onEvent({ type: 'tool_start', toolName: tc.name, toolUseId: tc.id });
      const content = await handleToolCall(tc.name, tc.input);
      onEvent({ type: 'tool_done', toolUseId: tc.id, result: content });
      results.push({ id: tc.id, name: tc.name, content });
    }
    entries.push({ kind: 'tool_results', results });
  }

  onEvent({ type: 'done' });
  return entries;
}
