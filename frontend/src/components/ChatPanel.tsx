import { useState, useRef, useEffect, useCallback } from 'react';
import type { Wire, CircuitElement, SimulationResult } from '../types/circuit';
import { runAgentTurn, type HistoryEntry, type StreamEvent } from '../ai/client';
import { MODEL_OPTIONS, DEFAULT_MODEL, SERVER_PROXY_URL, providerForModel, type ModelOption } from '../ai/providers';
import { parseToolCall, MUTATING_TOOLS } from '../ai/tools';
import { circuitToPrompt, simulationResultToPrompt } from '../ai/circuitToPrompt';
import { unsupportedOnPythonBackend } from '../ai/hqc';
import { classifyIntent, shouldForceTools, shouldAutoRunSimulation, type Intent } from '../ai/intent';
import { checkCircuit, withSanityNotes } from '../ai/sanity';
import { checkServerAIProviders } from '../api/backend';
import ChatMarkdown from './ChatMarkdown';

const TOOL_LABELS: Record<string, string> = {
  load_benchmark: 'Loading verified circuit',
  build_circuit: 'Building circuit',
  add_gate: 'Placing gate',
  remove_gate: 'Removing gate',
  add_wire: 'Adding wire',
  clear_circuit: 'Clearing circuit',
  read_circuit: 'Reading circuit',
  run_simulation: 'Running simulation',
};

/**
 * How many history entries to keep. Older turns are dropped wholesale — the canvas
 * snapshot on the newest message is authoritative anyway, so ancient context buys little
 * and costs on every subsequent request.
 */
const MAX_HISTORY_ENTRIES = 12;

const SNAPSHOT_RE = /^\[Canvas:[\s\S]*?\]\n\[Simulation:[\s\S]*?\]\n\n/;

type DisplayMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  actions: string[];
  isStreaming: boolean;
};

interface ChatPanelProps {
  wires: Wire[];
  elements: CircuitElement[];
  onAddWire: (type: 'qubit' | 'qumode') => void;
  onAddElement: (element: CircuitElement) => void;
  onApplyCircuit: (wires: Wire[], elements: CircuitElement[]) => void;
  onRemoveElement: (elementId: string) => void;
  onClearCanvas: () => void;
  onRunSimulation: (
    override?: { wires: Wire[]; elements: CircuitElement[] },
  ) => Promise<SimulationResult | null>;
  /** Benchmarks carry their own Fock truncation (the cat state needs 32). */
  onFockTruncationChange: (fock: number) => void;
  /** Incremented whenever the canvas is cleared — triggers conversation history reset */
  canvasVersion: number;
  simulationResult: SimulationResult | null;
  fockTruncation: number;
  backend: 'browser' | 'python';
}

function ls(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function lsSet(key: string, val: string) {
  try { localStorage.setItem(key, val); } catch { /* ignore */ }
}

/**
 * Strips the `[Canvas: …]` / `[Simulation: …]` prefix from an older user message.
 *
 * Only the newest message needs a live snapshot. Keeping the old ones meant every past
 * turn carried a full, stale copy of the circuit and its results forever — the single
 * largest source of token growth in a long conversation.
 */
function stripSnapshot(text: string): string {
  return text.replace(SNAPSHOT_RE, '[Canvas: superseded — see latest message]\n\n');
}

function pruneHistory(history: HistoryEntry[]): HistoryEntry[] {
  const stripped = history.map(entry =>
    entry.kind === 'user' ? { ...entry, text: stripSnapshot(entry.text) } : entry,
  );
  if (stripped.length <= MAX_HISTORY_ENTRIES) return stripped;

  // Drop from the front, but never start on a tool_results entry — providers reject a
  // tool result whose originating assistant turn is missing.
  let cut = stripped.length - MAX_HISTORY_ENTRIES;
  while (cut < stripped.length && stripped[cut].kind === 'tool_results') cut++;
  return stripped.slice(cut);
}

export default function ChatPanel({
  wires, elements, onAddWire, onAddElement, onApplyCircuit, onRemoveElement, onClearCanvas,
  onRunSimulation, onFockTruncationChange, canvasVersion, simulationResult, fockTruncation, backend,
}: ChatPanelProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Server key mode — backend holds the API key, user doesn't need one
  const [serverProviders, setServerProviders] = useState<Record<string, boolean>>({});
  const [useServerKey, setUseServerKey] = useState(() => ls('hyqsim-ai-server-key', 'false') === 'true');

  const [apiKey, setApiKey] = useState(() => ls('hyqsim-ai-key', ''));
  const [modelId, setModelId] = useState(() => ls('hyqsim-ai-model', DEFAULT_MODEL.id));
  const [baseUrl, setBaseUrl] = useState(() => {
    const savedModel = ls('hyqsim-ai-model', DEFAULT_MODEL.id);
    return MODEL_OPTIONS.find(m => m.id === savedModel)?.baseUrl ?? DEFAULT_MODEL.baseUrl;
  });
  const [apiFormat, setApiFormat] = useState<'openai' | 'anthropic'>(() => {
    const savedModel = ls('hyqsim-ai-model', DEFAULT_MODEL.id);
    return (MODEL_OPTIONS.find(m => m.id === savedModel) as ModelOption | undefined)?.apiFormat ?? DEFAULT_MODEL.apiFormat;
  });
  const [customModelId, setCustomModelId] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [input, setInput] = useState('');
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const isCustom = modelId === 'custom';
  const effectiveModelId = isCustom ? customModelId : modelId;

  const serverProviderName = providerForModel(modelId);
  const currentProviderOnServer = !!serverProviderName && !!serverProviders[serverProviderName];
  const serverKeyAvailable = Object.values(serverProviders).some(Boolean);
  const effectiveUseServerKey = useServerKey && currentProviderOnServer;

  const apiHistory = useRef<HistoryEntry[]>([]);
  const workingWires = useRef<Wire[]>(wires);
  const workingElements = useRef<CircuitElement[]>(elements);
  const simulationResultRef = useRef(simulationResult);
  const fockTruncationRef = useRef(fockTruncation);
  const backendRef = useRef(backend);
  /** Set for the duration of one send; gates mutating tools on read-only intents. */
  const currentIntent = useRef<Intent>('build');
  /** The message being handled — lets the sanity checks read the user's actual wording. */
  const currentPrompt = useRef<string>('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isProcessing) {
      workingWires.current = wires;
      workingElements.current = elements;
    }
  }, [wires, elements, isProcessing]);

  useEffect(() => { simulationResultRef.current = simulationResult; }, [simulationResult]);
  useEffect(() => { fockTruncationRef.current = fockTruncation; }, [fockTruncation]);
  useEffect(() => { backendRef.current = backend; }, [backend]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [displayMessages]);

  useEffect(() => {
    checkServerAIProviders().then(setServerProviders);
  }, []);

  // When the canvas is cleared externally, reset conversation history so the model doesn't
  // confuse the old circuit context with whatever is built next.
  //
  // Adjusted during render rather than in an effect: this is React's documented pattern for
  // reacting to a prop change, and it avoids the extra commit-then-rerender an effect would
  // cause (https://react.dev/learn/you-might-not-need-an-effect).
  const [seenCanvasVersion, setSeenCanvasVersion] = useState(canvasVersion);
  if (canvasVersion !== seenCanvasVersion) {
    setSeenCanvasVersion(canvasVersion);
    setDisplayMessages(prev => (
      prev.length === 0 ? prev : [
        ...prev,
        {
          id: `divider-${canvasVersion}`,
          role: 'assistant' as const,
          text: '— Canvas cleared · conversation history reset —',
          actions: [],
          isStreaming: false,
        },
      ]
    ));
  }

  // The conversation state itself lives in refs, which may only be written after render.
  // This always runs before the next handleSend, since that is user-triggered.
  useEffect(() => {
    if (canvasVersion === 0) return;
    apiHistory.current = [];
    workingWires.current = [];
    workingElements.current = [];
  }, [canvasVersion]);

  const saveApiKey = (key: string) => { setApiKey(key); lsSet('hyqsim-ai-key', key); };

  const toggleServerKey = (val: boolean) => {
    setUseServerKey(val);
    lsSet('hyqsim-ai-server-key', String(val));
  };

  const saveModel = (id: string) => {
    setModelId(id);
    lsSet('hyqsim-ai-model', id);
    if (id !== 'custom') {
      const option = MODEL_OPTIONS.find(m => m.id === id);
      const url = option?.baseUrl ?? baseUrl;
      setBaseUrl(url);
      lsSet('hyqsim-ai-baseurl', url);
      setApiFormat(option?.apiFormat ?? 'openai');
    }
  };

  const saveBaseUrl = (url: string) => { setBaseUrl(url); lsSet('hyqsim-ai-baseurl', url); };

  /**
   * Runs the real simulator on the circuit the assistant is currently holding.
   *
   * The override is essential: within one agent turn the assistant may build a circuit and
   * then ask for results, and React state has not committed yet. Passing the shadow copy
   * guarantees we simulate what the model just built rather than what was there before.
   */
  const runSimulationForAgent = useCallback(async (): Promise<string> => {
    const w = workingWires.current;
    const e = workingElements.current;
    if (w.length === 0) return 'Nothing to simulate — the circuit is empty.';

    if (backendRef.current === 'python') {
      const bad = unsupportedOnPythonBackend(e);
      if (bad.length > 0) {
        return `Cannot simulate: the Python (bosonic-qiskit) backend does not support ${bad.join(', ')}. Tell the user to switch the backend to "browser" in the right-hand panel, then ask again.`;
      }
    }

    const result = await onRunSimulation({ wires: w, elements: e });
    if (!result) return 'The simulator returned an error. Check the browser console.';
    simulationResultRef.current = result;
    return simulationResultToPrompt(result, w, fockTruncationRef.current);
  }, [onRunSimulation]);

  const handleToolCall = useCallback(async (
    name: string, toolInput: Record<string, unknown>,
  ): Promise<string> => {
    // Guard rail for the failure mode users complained about most: asking for an
    // explanation and having the assistant quietly rebuild the canvas.
    if (MUTATING_TOOLS.has(name) && currentIntent.current !== 'build') {
      return `Refused: this is a ${currentIntent.current} request, not a build request. Answer from the [Canvas: ...] and [Simulation: ...] snapshots instead of modifying the circuit.`;
    }

    const result = parseToolCall(name, toolInput, workingWires.current, workingElements.current);
    if (result.error || !result.mutation) return `Error: ${result.error}`;
    const mutation = result.mutation;

    switch (mutation.type) {
      case 'read_circuit':
        return circuitToPrompt(workingWires.current, workingElements.current);

      case 'run_simulation':
        return runSimulationForAgent();

      case 'clear_circuit':
        onClearCanvas(); // also bumps canvasVersion → history reset once processing ends
        workingWires.current = [];
        workingElements.current = [];
        return 'Circuit cleared.';

      case 'load_benchmark': {
        onApplyCircuit(mutation.wires, mutation.elements);
        onFockTruncationChange(mutation.fockTruncation);
        workingWires.current = mutation.wires;
        workingElements.current = mutation.elements;
        fockTruncationRef.current = mutation.fockTruncation;
        return `Loaded HyQSim's verified "${mutation.benchmarkId}" circuit (Fock truncation set to ${mutation.fockTruncation}): ${circuitToPrompt(mutation.wires, mutation.elements)}`;
      }

      case 'build_circuit': {
        onApplyCircuit(mutation.wires, mutation.elements);
        workingWires.current = mutation.wires;
        workingElements.current = mutation.elements;
        // Structural checks run here so a flawed circuit is flagged in the same turn the
        // model built it, giving it a chance to fix things before it starts explaining.
        return withSanityNotes(
          `Built: ${circuitToPrompt(mutation.wires, mutation.elements)}`,
          checkCircuit(mutation.wires, mutation.elements, currentPrompt.current),
        );
      }

      case 'add_wire': {
        const wt = mutation.wireType;
        const typeCount = workingWires.current.filter(w => w.type === wt).length;
        onAddWire(wt);
        workingWires.current = [
          ...workingWires.current,
          { id: `${wt}-${Date.now()}`, type: wt, index: typeCount },
        ];
        return `Added ${wt} ${wt === 'qubit' ? 'q' : 'm'}${typeCount}.`;
      }

      case 'add_gate': {
        // The element is fully formed and carries its own id, so the shadow copy and the
        // real canvas stay in agreement — which is what positional #N refs rely on.
        onAddElement(mutation.element);
        workingElements.current = [...workingElements.current, mutation.element];
        return withSanityNotes(
          `Added gate #${workingElements.current.length}. Circuit: ${circuitToPrompt(workingWires.current, workingElements.current)}`,
          checkCircuit(workingWires.current, workingElements.current, currentPrompt.current),
        );
      }

      case 'remove_gate': {
        onRemoveElement(mutation.elementId);
        workingElements.current = workingElements.current.filter(e => e.id !== mutation.elementId);
        return `Removed gate ${mutation.ref}. Circuit: ${circuitToPrompt(workingWires.current, workingElements.current)}`;
      }
    }
  }, [onAddWire, onAddElement, onApplyCircuit, onRemoveElement, onClearCanvas, onFockTruncationChange, runSimulationForAgent]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const needsKey = !effectiveUseServerKey;
    if (!text || isProcessing || (needsKey && !apiKey) || !effectiveModelId) return;

    setInput('');
    setIsProcessing(true);

    const intent = classifyIntent(text);
    currentIntent.current = intent;
    currentPrompt.current = text;

    setDisplayMessages(prev => [...prev, {
      id: `user-${Date.now()}`, role: 'user', text, actions: [], isStreaming: false,
    }]);

    const assistantId = `assistant-${Date.now()}`;
    setDisplayMessages(prev => [...prev, {
      id: assistantId, role: 'assistant', text: '', actions: [], isStreaming: true,
    }]);

    const pushAction = (label: string) => {
      setDisplayMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, actions: [...m.actions, label] } : m,
      ));
    };

    // HyQSim runs the simulation, never the model. For a results question with no fresh
    // result, run it up front so the answer is grounded in real numbers rather than the
    // model's guess about what the circuit "should" produce.
    if (shouldAutoRunSimulation(intent, simulationResultRef.current !== null, workingWires.current.length > 0)) {
      pushAction('⚙ Running simulation…');
      const summary = await runSimulationForAgent();
      setDisplayMessages(prev => prev.map(m => {
        if (m.id !== assistantId) return m;
        const updated = [...m.actions];
        updated[updated.length - 1] = summary.startsWith('Cannot') || summary.startsWith('Nothing') || summary.startsWith('The simulator')
          ? `✗ ${summary.slice(0, 70)}`
          : '✓ Simulation complete';
        return { ...m, actions: updated };
      }));
    }

    // Inject a live canvas + simulation snapshot so the model always has current ground
    // truth. Only this message carries one; pruneHistory strips it from older turns.
    const canvasSnap = `[Canvas: ${circuitToPrompt(workingWires.current, workingElements.current)}]`;
    const simSnap = simulationResultRef.current
      ? `[Simulation: ${simulationResultToPrompt(simulationResultRef.current, workingWires.current, fockTruncationRef.current)}]`
      : '[Simulation: not run]';
    const apiText = `${canvasSnap}\n${simSnap}\n\n${text}`;
    apiHistory.current = pruneHistory([...apiHistory.current, { kind: 'user', text: apiText }]);

    const onEvent = (event: StreamEvent) => {
      switch (event.type) {
        case 'text':
          setDisplayMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, text: m.text + event.text } : m
          ));
          break;
        case 'tool_start':
          pushAction(`⚙ ${TOOL_LABELS[event.toolName] ?? event.toolName}…`);
          break;
        case 'tool_done':
          setDisplayMessages(prev => prev.map(m => {
            if (m.id !== assistantId) return m;
            const failed = event.result.startsWith('Error') || event.result.startsWith('Refused');
            const firstLine = event.result.split('\n')[0];
            const summary = firstLine.length > 72 ? firstLine.slice(0, 70) + '…' : firstLine;
            const updated = [...m.actions];
            updated[updated.length - 1] = `${failed ? '✗' : '✓'} ${summary}`;
            return { ...m, actions: updated };
          }));
          break;
        case 'rate_limited':
          pushAction(`⏳ Rate limited — retrying in ${event.delaySeconds}s (attempt ${event.attempt}/3)…`);
          break;
        case 'done':
          setDisplayMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, isStreaming: false } : m
          ));
          setIsProcessing(false);
          break;
        case 'error':
          setDisplayMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, text: m.text || event.message, isStreaming: false } : m
          ));
          setIsProcessing(false);
          break;
      }
    };

    const effectiveApiFormat = isCustom ? 'openai' : apiFormat;
    const effectiveBaseUrl = effectiveUseServerKey ? SERVER_PROXY_URL : baseUrl;
    const effectiveApiKey = effectiveUseServerKey ? '' : apiKey;
    const updatedHistory = await runAgentTurn(
      effectiveApiKey, effectiveModelId, effectiveBaseUrl, effectiveApiFormat,
      apiHistory.current, onEvent, handleToolCall, effectiveUseServerKey,
      shouldForceTools(intent), intent,
    );
    apiHistory.current = pruneHistory(updatedHistory);
  }, [
    input, isProcessing, apiKey, effectiveModelId, baseUrl, apiFormat, isCustom,
    effectiveUseServerKey, handleToolCall, runSimulationForAgent,
  ]);

  const handleToggle = () => {
    setIsOpen(o => {
      if (!o) setTimeout(() => inputRef.current?.focus(), 150);
      return !o;
    });
  };

  return (
    <div
      className="border-t border-slate-700 bg-slate-900 flex flex-col shrink-0 transition-all duration-200"
      style={{ height: isOpen ? '288px' : '36px' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 h-9 cursor-pointer select-none shrink-0"
        onClick={handleToggle}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-300">AI Assistant</span>
          {isProcessing && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
        </div>
        <span className="text-[10px] text-slate-500">{isOpen ? '▼' : '▲'}</span>
      </div>

      {isOpen && (
        <>
          {/* Settings */}
          <div className="px-3 pb-2 space-y-1.5 shrink-0" onClick={e => e.stopPropagation()}>

            {/* Server key toggle — only shown when backend has at least one provider configured */}
            {serverKeyAvailable && (
              <div className="flex items-center gap-2 bg-emerald-950 border border-emerald-800 rounded px-2 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                <span className="text-[10px] text-emerald-300 flex-1">Server key available — no API key needed</span>
                <button
                  onClick={() => toggleServerKey(!useServerKey)}
                  className={`text-[10px] px-2 py-0.5 rounded transition-colors shrink-0 ${
                    useServerKey
                      ? 'bg-emerald-700 text-white'
                      : 'bg-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {useServerKey ? 'Using server key' : 'Use server key'}
                </button>
              </div>
            )}

            {/* Row 1: API key — hidden when server key is active for the selected model */}
            {!effectiveUseServerKey && (
              <div className="flex items-center gap-1.5 bg-slate-800 rounded px-2 py-1 border border-slate-700">
                <span className="text-[10px] text-slate-500 shrink-0">API Key</span>
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => saveApiKey(e.target.value)}
                  placeholder="sk-... or gsk_..."
                  className="flex-1 bg-transparent text-xs text-slate-300 outline-none placeholder:text-slate-600 min-w-0"
                />
                <button
                  onClick={() => setShowApiKey(v => !v)}
                  className="text-[10px] text-slate-500 hover:text-slate-300 shrink-0"
                >
                  {showApiKey ? 'hide' : 'show'}
                </button>
              </div>
            )}

            {/* Row 2: model + base URL */}
            <div className="flex items-center gap-2">
              <select
                value={modelId}
                onChange={e => saveModel(e.target.value)}
                className="bg-slate-800 text-xs text-slate-300 rounded px-2 py-1 outline-none border border-slate-700 cursor-pointer shrink-0"
              >
                {MODEL_OPTIONS.map(m => {
                  const provider = providerForModel(m.id);
                  const hasServerKey = serverKeyAvailable && !!provider && !!serverProviders[provider];
                  return (
                    <option key={m.id} value={m.id}>
                      {hasServerKey ? '★ ' : ''}{m.label}
                    </option>
                  );
                })}
                <option value="custom">Custom…</option>
              </select>

              {isCustom ? (
                <input
                  type="text"
                  value={customModelId}
                  onChange={e => setCustomModelId(e.target.value)}
                  placeholder="model name"
                  className="flex-1 bg-slate-800 text-xs text-slate-300 rounded px-2 py-1 outline-none border border-slate-700 placeholder:text-slate-600 min-w-0"
                />
              ) : effectiveUseServerKey ? (
                <span className="flex-1 text-[10px] text-emerald-400 px-2">
                  {currentProviderOnServer ? 'routed via server' : 'no server key for this model — switch model or enter API key'}
                </span>
              ) : (
                <input
                  type="text"
                  value={baseUrl}
                  onChange={e => saveBaseUrl(e.target.value)}
                  className="flex-1 bg-slate-800 text-xs text-slate-300 rounded px-2 py-1 outline-none border border-slate-700 min-w-0 font-mono"
                  title="Base URL"
                />
              )}
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 space-y-2 min-h-0 pb-1">
            {displayMessages.length === 0 ? (
              <p className="text-[11px] text-slate-600 italic pt-1">
                Ask me to build a circuit, explain what is on the canvas, or analyse the results.
              </p>
            ) : (
              displayMessages.map(msg => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[86%] rounded-lg px-3 py-1.5 text-xs leading-relaxed ${
                    msg.role === 'user' ? 'bg-blue-700 text-white' : 'bg-slate-800 text-slate-200'
                  }`}>
                    {msg.text && (
                      msg.role === 'assistant'
                        ? <ChatMarkdown text={msg.text} />
                        : <p className="whitespace-pre-wrap">{msg.text}</p>
                    )}
                    {msg.actions.length > 0 && (
                      <div className={`space-y-0.5 ${msg.text ? 'mt-1.5 pt-1.5 border-t border-slate-700' : ''}`}>
                        {msg.actions.map((a, i) => (
                          <p key={i} className="text-[10px] text-slate-400 font-mono">{a}</p>
                        ))}
                      </div>
                    )}
                    {msg.isStreaming && (
                      <span className="inline-block w-1 h-3 bg-blue-400 animate-pulse align-middle ml-0.5" />
                    )}
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="flex gap-2 px-3 py-2 shrink-0 border-t border-slate-800">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder={
                effectiveUseServerKey
                  ? (currentProviderOnServer ? 'Ask me to build a circuit…' : 'No server key for this model — pick another model')
                  : (apiKey ? 'Ask me to build a circuit…' : 'Enter an API key above to get started')
              }
              disabled={isProcessing || (!effectiveUseServerKey && !apiKey) || (effectiveUseServerKey && !currentProviderOnServer)}
              className="flex-1 bg-slate-800 text-xs text-white rounded px-3 py-1.5 outline-none border border-slate-700 focus:border-blue-500 placeholder:text-slate-600 disabled:opacity-50 transition-colors"
            />
            <button
              onClick={handleSend}
              disabled={isProcessing || !input.trim() || (!effectiveUseServerKey && !apiKey) || (effectiveUseServerKey && !currentProviderOnServer) || !effectiveModelId}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-xs rounded transition-colors font-medium"
            >
              {isProcessing ? '…' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
