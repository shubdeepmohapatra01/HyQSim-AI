import { AI_TOOLS, buildSystemPrompt, toolsForIntent, type PromptIntent } from './tools';
import { canonicalGateId } from './hqc';

// ─── Model registry ───────────────────────────────────────────────────────────

// Optional chaining matters: the eval harness imports this module under plain Node, where
// `import.meta.env` does not exist at all.
const DEV = import.meta.env?.DEV ?? false;

export interface ModelOption {
  id: string;
  label: string;
  baseUrl: string;
  apiFormat: 'openai' | 'anthropic';
  /** max_tokens to request — kept low for rate-limited free tiers */
  maxTokens: number;
}

const GROQ_BASE = DEV ? '/proxy/groq/openai/v1' : 'https://api.groq.com/openai/v1';
const ANTHROPIC_BASE = DEV ? '/proxy/anthropic' : 'https://api.anthropic.com';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

export const MODEL_OPTIONS: ModelOption[] = [
  // Claude (Anthropic) — best tool calling, no rate-limit concerns on paid tier
  { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6 (Anthropic)', baseUrl: ANTHROPIC_BASE,                                                    apiFormat: 'anthropic', maxTokens: 2048 },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (Anthropic)',  baseUrl: ANTHROPIC_BASE,                                                    apiFormat: 'anthropic', maxTokens: 2048 },
  { id: 'claude-opus-4-8',           label: 'Claude Opus 4.8 (Anthropic)',   baseUrl: ANTHROPIC_BASE,                                                    apiFormat: 'anthropic', maxTokens: 2048 },
  // OpenAI
  { id: 'gpt-4o',                    label: 'GPT-4o',                        baseUrl: 'https://api.openai.com/v1',                                       apiFormat: 'openai',    maxTokens: 2048 },
  { id: 'gpt-4o-mini',               label: 'GPT-4o mini',                   baseUrl: 'https://api.openai.com/v1',                                       apiFormat: 'openai',    maxTokens: 1024 },
  { id: 'o3-mini',                   label: 'o3-mini',                       baseUrl: 'https://api.openai.com/v1',                                       apiFormat: 'openai',    maxTokens: 2048 },
  // Google Gemini — no credit card, but the free tier is tight: gemini-3.6-flash reported a
  // quota limit of 5 requests. Two further traps, both hit in practice:
  //   1. The catalogue lists models a key cannot use. The whole 2.5 generation is closed to
  //      new keys — 2.5-flash and 2.5-pro both 404 with "no longer available to new users"
  //      while still appearing in the list. Listing != access; check `ai:models --verify`.
  //   2. Quota errors surface as 429 and sometimes 400, which reads like a broken request.
  //
  // All four below were confirmed callable on a new key on 2026-08-11 via
  // `npm run ai:models -- --verify`. gemini-2.0-flash and gemini-1.5-pro were retired
  // outright. Re-run that check rather than guessing if one stops working.
  { id: 'gemini-3.5-flash',          label: 'Gemini 3.5 Flash (Google)',      baseUrl: GEMINI_BASE,                                                      apiFormat: 'openai',    maxTokens: 2048 },
  { id: 'gemini-3.5-flash-lite',     label: 'Gemini 3.5 Flash Lite (Google)', baseUrl: GEMINI_BASE,                                                      apiFormat: 'openai',    maxTokens: 2048 },
  { id: 'gemini-3.6-flash',          label: 'Gemini 3.6 Flash (Google)',      baseUrl: GEMINI_BASE,                                                      apiFormat: 'openai',    maxTokens: 2048 },
  // Floating alias: always resolves to Google's current Flash. Survives id retirements,
  // at the cost of the model changing under you between runs — pin a version above when
  // you need an eval to be reproducible.
  { id: 'gemini-flash-latest',       label: 'Gemini Flash (latest, auto-updates)', baseUrl: GEMINI_BASE,                                                 apiFormat: 'openai',    maxTokens: 2048 },
  // Groq — free tier but tight TPM limits; keep maxTokens low to avoid rate errors
  { id: 'llama-3.3-70b-versatile',   label: 'Llama 3.3 70B (Groq)',          baseUrl: GROQ_BASE,                                                         apiFormat: 'openai',    maxTokens: 1024 },
  { id: 'llama-3.1-8b-instant',      label: 'Llama 3.1 8B (Groq) ⚠ low TPM', baseUrl: GROQ_BASE,                                                       apiFormat: 'openai',    maxTokens: 512  },
  // Together
  { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B (Together)', baseUrl: 'https://api.together.xyz/v1',                           apiFormat: 'openai',    maxTokens: 2048 },
  // Mistral
  { id: 'mistral-large-latest',      label: 'Mistral Large',                 baseUrl: 'https://api.mistral.ai/v1',                                       apiFormat: 'openai',    maxTokens: 2048 },
];

export const DEFAULT_MODEL = MODEL_OPTIONS[0]; // Claude Sonnet 4.6

/**
 * Maps a model id to the backend provider that holds a key for it.
 *
 * Single source of truth: this used to be duplicated in three places (twice in ChatPanel,
 * once in backend/main.py) and the copies had drifted apart, so a model could show a
 * "server key available" star and then fail to route. Must stay in sync with
 * `_AI_PROVIDERS` in backend/main.py.
 */
export function providerForModel(modelId: string): string | null {
  if (!modelId || modelId === 'custom') return null;
  if (modelId.startsWith('claude-')) return 'anthropic';
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1-') || modelId.startsWith('o3-')) return 'openai';
  if (modelId.startsWith('llama-') || modelId.startsWith('mixtral-') || modelId.startsWith('gemma-')) return 'groq';
  if (modelId.startsWith('gemini-')) return 'google';
  if (modelId.startsWith('mistral-') || modelId.startsWith('codestral-')) return 'mistral';
  if (modelId.startsWith('meta-llama/') || modelId.includes('Turbo')) return 'together';
  return null;
}

// Backend proxy URL — used when serverKey mode is active
const BACKEND_URL = import.meta.env?.VITE_BACKEND_URL || 'http://localhost:8000';
export const SERVER_PROXY_URL = `${BACKEND_URL}/ai/chat`;

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

function historyToOAIMessages(history: HistoryEntry[], intent: PromptIntent): OAIMessage[] {
  const out: OAIMessage[] = [{ role: 'system', content: buildSystemPrompt(intent) }];
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

function oaiToolsFor(intent: PromptIntent) {
  return toolsForIntent(intent).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function buildOAIRequest(
  apiKey: string, baseUrl: string, modelId: string, history: HistoryEntry[], withTools: boolean, forceTools: boolean, maxTokens: number,
  intent: PromptIntent,
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
        max_tokens: maxTokens,
        ...(withTools ? { tools: oaiToolsFor(intent), tool_choice: forceTools ? 'required' : 'auto' } : {}),
        messages: historyToOAIMessages(history, intent),
      }),
    },
  };
}

// Strip Llama-family special tokens (e.g. <|python_tag|>) that leak into text responses.
const SPECIAL_TOKEN_RE = /<\|[^|>]*\|>/g;

// Matches <function=NAME ATTRS>...</function> pseudo-calls emitted as plain text by some models.
const FUNC_TAG_RE = /<function=(\w+)((?:\s+[\w]+=(?:"[^"]*"|\{[^}]*\}))*)\s*>[\s\S]*?<\/function>/g;
const FUNC_ATTR_RE = /([\w]+)=(?:"([^"]*)"|(\{[^}]*\}))/g;

// Models that output <function=...> pseudo-XML use non-standard parameter names; normalize them.
const PARAM_NAME_MAP: Record<string, string> = {
  wire_type: 'wireType',
  gate_type: 'gateId',
  gate_id: 'gateId',
  wire_label: 'wireLabel',
  target_wire_label: 'targetWireLabel',
  params: 'parameters',
  element_id: 'ref',
  elementId: 'ref',
  gate_spec: 'gates',
  wire_spec: 'wires',
};

const KNOWN_TOOLS = new Set(AI_TOOLS.map(t => t.name));

function parseFunctionCallText(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  FUNC_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FUNC_TAG_RE.exec(text)) !== null) {
    const toolName = m[1];
    if (!KNOWN_TOOLS.has(toolName)) continue;

    const attrsStr = m[2];
    const input: Record<string, unknown> = {};
    FUNC_ATTR_RE.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = FUNC_ATTR_RE.exec(attrsStr)) !== null) {
      const rawName = a[1];
      const strVal = a[2];
      const jsonVal = a[3];
      const key = PARAM_NAME_MAP[rawName] ?? rawName;
      if (jsonVal !== undefined) {
        try { input[key] = JSON.parse(jsonVal); } catch { input[key] = jsonVal; }
      } else {
        input[key] = strVal;
      }
    }

    if (typeof input.gateId === 'string') {
      input.gateId = canonicalGateId(input.gateId);
    }

    calls.push({ id: `fb-${Date.now()}-${calls.length}`, name: toolName, input });
  }
  return calls;
}

function parseOAIResponse(data: unknown): ParsedResponse {
  const d = data as {
    choices: {
      message: {
        content: string | null;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      };
    }[];
  };
  const msg = d.choices[0].message;
  let text = (msg.content ?? '').replace(SPECIAL_TOKEN_RE, '').trim();
  let toolCalls = (msg.tool_calls ?? []).map(tc => ({
    id: tc.id,
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
  }));

  // Fallback: some models output <function=...> XML as plain text instead of real tool_calls.
  if (toolCalls.length === 0 && text.includes('<function=')) {
    toolCalls = parseFunctionCallText(text);
    FUNC_TAG_RE.lastIndex = 0;
    text = text.replace(FUNC_TAG_RE, '').trim();
  }

  return { text, toolCalls, isToolUse: toolCalls.length > 0 };
}

// ─── Anthropic (Claude) request/response ─────────────────────────────────────

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

function historyToAnthropicMessages(history: HistoryEntry[]): AnthropicMessage[] {
  const msgs: AnthropicMessage[] = [];
  for (const entry of history) {
    if (entry.kind === 'user') {
      msgs.push({ role: 'user', content: entry.text });
    } else if (entry.kind === 'assistant') {
      const content: AnthropicContentBlock[] = [];
      if (entry.text) content.push({ type: 'text', text: entry.text });
      for (const tc of entry.toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      // Anthropic requires content to be a string when there are no tool calls
      msgs.push({
        role: 'assistant',
        content: content.length === 1 && content[0].type === 'text' ? content[0].text : content,
      });
    } else {
      // Tool results go as a user message
      const content: AnthropicContentBlock[] = entry.results.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.id,
        content: r.content,
      }));
      msgs.push({ role: 'user', content });
    }
  }
  return msgs;
}

function anthropicToolsFor(intent: PromptIntent) {
  return toolsForIntent(intent).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

function buildAnthropicRequest(
  apiKey: string, baseUrl: string, modelId: string, history: HistoryEntry[], withTools: boolean, forceTools: boolean, maxTokens: number,
  intent: PromptIntent,
): { url: string; options: RequestInit } {
  return {
    url: `${baseUrl}/v1/messages`,
    options: {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-request-allow-browser': 'true',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        system: buildSystemPrompt(intent),
        messages: historyToAnthropicMessages(history),
        ...(withTools ? { tools: anthropicToolsFor(intent), tool_choice: { type: forceTools ? 'any' : 'auto' } } : {}),
      }),
    },
  };
}

function parseAnthropicResponse(data: unknown): ParsedResponse {
  const d = data as {
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    >;
    stop_reason: string;
  };

  let text = '';
  const toolCalls: ToolCall[] = [];

  for (const block of d.content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }

  return { text, toolCalls, isToolUse: toolCalls.length > 0 };
}

// ─── Unified dispatch ─────────────────────────────────────────────────────────

export interface ParsedResponse {
  text: string;
  toolCalls: ToolCall[];
  isToolUse: boolean;
}

export function buildRequest(
  apiKey: string, baseUrl: string, modelId: string,
  apiFormat: 'openai' | 'anthropic',
  history: HistoryEntry[], withTools = true, forceTools = false,
  useServerProxy = false,
  /** Scopes the system prompt and tool list; read-only intents get a much smaller payload. */
  intent: PromptIntent = 'build',
): { url: string; options: RequestInit } {
  const maxTokens = MODEL_OPTIONS.find(m => m.id === modelId)?.maxTokens ?? 1024;

  if (useServerProxy) {
    // Route through the HyQSim backend — it adds the API key server-side.
    const inner = apiFormat === 'anthropic'
      ? buildAnthropicRequest('', baseUrl, modelId, history, withTools, forceTools, maxTokens, intent)
      : buildOAIRequest('', baseUrl, modelId, history, withTools, forceTools, maxTokens, intent);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiFormat === 'anthropic') headers['anthropic-version'] = '2023-06-01';
    // Matches AI_PROXY_TOKEN on the backend. Only needed for deployments that lock the
    // proxy down; local development leaves both unset.
    const proxyToken = import.meta.env?.VITE_AI_PROXY_TOKEN;
    if (proxyToken) headers['x-hyqsim-proxy-token'] = proxyToken;
    return { url: baseUrl, options: { ...inner.options, headers } };
  }

  return apiFormat === 'anthropic'
    ? buildAnthropicRequest(apiKey, baseUrl, modelId, history, withTools, forceTools, maxTokens, intent)
    : buildOAIRequest(apiKey, baseUrl, modelId, history, withTools, forceTools, maxTokens, intent);
}

export function parseResponse(data: unknown, apiFormat: 'openai' | 'anthropic'): ParsedResponse {
  return apiFormat === 'anthropic'
    ? parseAnthropicResponse(data)
    : parseOAIResponse(data);
}
