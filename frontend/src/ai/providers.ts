import { SYSTEM_PROMPT, AI_TOOLS } from './tools';

// ─── Model registry ───────────────────────────────────────────────────────────

const DEV = import.meta.env.DEV;

export interface ModelOption {
  id: string;
  label: string;
  baseUrl: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'gpt-4o',           label: 'GPT-4o',                              baseUrl: 'https://api.openai.com/v1' },
  { id: 'gpt-4o-mini',      label: 'GPT-4o mini',                         baseUrl: 'https://api.openai.com/v1' },
  { id: 'o3-mini',          label: 'o3-mini',                              baseUrl: 'https://api.openai.com/v1' },
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq)',         baseUrl: DEV ? '/proxy/groq/openai/v1' : 'https://api.groq.com/openai/v1' },
  { id: 'llama-3.1-8b-instant',    label: 'Llama 3.1 8B (Groq)',          baseUrl: DEV ? '/proxy/groq/openai/v1' : 'https://api.groq.com/openai/v1' },
  { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B (Together)', baseUrl: 'https://api.together.xyz/v1' },
  { id: 'mistral-large-latest', label: 'Mistral Large',                   baseUrl: 'https://api.mistral.ai/v1' },
];

export const DEFAULT_MODEL = MODEL_OPTIONS[3]; // Llama 3.3 70B (Groq)

// ─── Unified conversation history ─────────────────────────────────────────────

export type ToolCall   = { id: string; name: string; input: Record<string, unknown> };
export type ToolResult = { id: string; name: string; content: string };

export type HistoryEntry =
  | { kind: 'user';         text: string }
  | { kind: 'assistant';    text: string; toolCalls: ToolCall[] }
  | { kind: 'tool_results'; results: ToolResult[] };

// ─── OpenAI-compatible request/response ──────────────────────────────────────

type OAIMessage =
  | { role: 'system';    content: string }
  | { role: 'user';      content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool';      tool_call_id: string; content: string };

function historyToMessages(history: HistoryEntry[]): OAIMessage[] {
  const out: OAIMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const entry of history) {
    if (entry.kind === 'user') {
      out.push({ role: 'user', content: entry.text });
    } else if (entry.kind === 'assistant') {
      if (entry.toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: entry.text || null,
          tool_calls: entry.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        });
      } else {
        out.push({ role: 'assistant', content: entry.text });
      }
    } else {
      for (const r of entry.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
    }
  }
  return out;
}

const tools = AI_TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

export function buildRequest(
  apiKey: string, baseUrl: string, modelId: string, history: HistoryEntry[], withTools = true,
): { url: string; options: RequestInit } {
  return {
    url: `${baseUrl}/chat/completions`,
    options: {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 4096,
        ...(withTools ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
        messages: historyToMessages(history),
      }),
    },
  };
}

export interface ParsedResponse {
  text: string;
  toolCalls: ToolCall[];
  isToolUse: boolean;
}

export function parseResponse(data: unknown): ParsedResponse {
  const d = data as {
    choices: {
      message: {
        content: string | null;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      };
    }[];
  };
  const msg = d.choices[0].message;
  const text = msg.content ?? '';
  const toolCalls = (msg.tool_calls ?? []).map(tc => ({
    id: tc.id,
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
  }));
  return { text, toolCalls, isToolUse: toolCalls.length > 0 };
}
