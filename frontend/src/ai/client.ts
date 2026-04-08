import type { HistoryEntry, ToolResult } from './providers';
import { buildRequest, parseResponse } from './providers';

export type { HistoryEntry } from './providers';

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; toolName: string; toolUseId: string }
  | { type: 'tool_done'; toolUseId: string; result: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

const MAX_TURNS = 10;

function isToolGenerationFailure(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('failed to call a function') || m.includes('failed_generation');
}

export async function runAgentTurn(
  apiKey: string,
  modelId: string,
  baseUrl: string,
  history: HistoryEntry[],
  onEvent: (event: StreamEvent) => void,
  handleToolCall: (name: string, input: Record<string, unknown>) => Promise<string>,
): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [...history];
  let withTools = true;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const { url, options } = buildRequest(apiKey, baseUrl, modelId, entries, withTools);

    let response: Response;
    try {
      response = await fetch(url, options);
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
      if (withTools && isToolGenerationFailure(msg)) {
        withTools = false;
        continue;
      }
      onEvent({ type: 'error', message: msg });
      return entries;
    }

    const data = await response.json();
    const { text, toolCalls, isToolUse } = parseResponse(data);

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
