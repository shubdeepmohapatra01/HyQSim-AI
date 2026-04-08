import { useState, useRef, useEffect, useCallback } from 'react';
import type { Wire, CircuitElement, Gate } from '../types/circuit';
import { runAgentTurn, type HistoryEntry, type StreamEvent } from '../ai/client';
import { MODEL_OPTIONS, DEFAULT_MODEL } from '../ai/providers';
import { parseToolCall } from '../ai/tools';
import { circuitToPrompt, wireLabel } from '../ai/circuitToPrompt';

const TOOL_LABELS: Record<string, string> = {
  read_circuit: 'Reading circuit',
  add_wire: 'Adding wire',
  add_gate: 'Placing gate',
  remove_gate: 'Removing gate',
  clear_circuit: 'Clearing circuit',
};

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
  onDropGate: (gate: Gate, wireIndex: number, position: { x: number; y: number }, targetWireIndices?: number[]) => void;
  onRemoveElement: (elementId: string) => void;
  onClearCanvas: () => void;
}

function ls(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function lsSet(key: string, val: string) {
  try { localStorage.setItem(key, val); } catch { /* ignore */ }
}

export default function ChatPanel({
  wires, elements, onAddWire, onDropGate, onRemoveElement, onClearCanvas,
}: ChatPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [apiKey, setApiKey] = useState(() => ls('hyqsim-ai-key', ''));
  const [modelId, setModelId] = useState(() => ls('hyqsim-ai-model', DEFAULT_MODEL.id));
  const [baseUrl, setBaseUrl] = useState(() => {
    const savedModel = ls('hyqsim-ai-model', DEFAULT_MODEL.id);
    return MODEL_OPTIONS.find(m => m.id === savedModel)?.baseUrl ?? DEFAULT_MODEL.baseUrl;
  });
  const [customModelId, setCustomModelId] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [input, setInput] = useState('');
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const isCustom = modelId === 'custom';
  const effectiveModelId = isCustom ? customModelId : modelId;

  const apiHistory = useRef<HistoryEntry[]>([]);
  const workingWires = useRef<Wire[]>(wires);
  const workingElements = useRef<CircuitElement[]>(elements);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isProcessing) {
      workingWires.current = wires;
      workingElements.current = elements;
    }
  }, [wires, elements, isProcessing]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [displayMessages]);

  const saveApiKey = (key: string) => { setApiKey(key); lsSet('hyqsim-ai-key', key); };

  const saveModel = (id: string) => {
    setModelId(id);
    lsSet('hyqsim-ai-model', id);
    if (id !== 'custom') {
      const url = MODEL_OPTIONS.find(m => m.id === id)?.baseUrl ?? baseUrl;
      setBaseUrl(url);
      lsSet('hyqsim-ai-baseurl', url);
    }
  };

  const saveBaseUrl = (url: string) => { setBaseUrl(url); lsSet('hyqsim-ai-baseurl', url); };

  const handleToolCall = useCallback(async (
    name: string, toolInput: Record<string, unknown>,
  ): Promise<string> => {
    const { mutation, error } = parseToolCall(name, toolInput, workingWires.current, workingElements.current);
    if (error) return `Error: ${error}`;

    switch (mutation.type) {
      case 'read_circuit':
        return circuitToPrompt(workingWires.current, workingElements.current);

      case 'clear_circuit':
        onClearCanvas();
        workingWires.current = [];
        workingElements.current = [];
        return 'Circuit cleared.';

      case 'add_wire': {
        const wt = mutation.wireType;
        onAddWire(wt);
        const typeCount = workingWires.current.filter(w => w.type === wt).length;
        const label = wt === 'qubit' ? `q${typeCount}` : `m${typeCount}`;
        workingWires.current = [...workingWires.current, { id: `pending-${Date.now()}`, type: wt, index: typeCount }];
        return `Added ${wt} wire ${label}.`;
      }

      case 'add_gate': {
        const { gate, wireIndex, position, targetWireIndices, parameterValues } = mutation;
        onDropGate(gate, wireIndex, position, targetWireIndices);
        workingElements.current = [...workingElements.current, {
          id: `pending-${Date.now()}`, gateId: gate.id, position, wireIndex, targetWireIndices, parameterValues,
        }];
        const primary = wireLabel(workingWires.current, wireIndex);
        const target = targetWireIndices ? ` → ${wireLabel(workingWires.current, targetWireIndices[0])}` : '';
        return `Added ${gate.name} on ${primary}${target}.`;
      }

      case 'remove_gate':
        onRemoveElement(mutation.elementId);
        workingElements.current = workingElements.current.filter(e => e.id !== mutation.elementId);
        return `Removed gate ${mutation.elementId}.`;
    }
  }, [onAddWire, onDropGate, onRemoveElement, onClearCanvas]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isProcessing || !apiKey || !effectiveModelId) return;

    setInput('');
    setIsProcessing(true);

    setDisplayMessages(prev => [...prev, {
      id: `user-${Date.now()}`, role: 'user', text, actions: [], isStreaming: false,
    }]);
    apiHistory.current = [...apiHistory.current, { kind: 'user', text }];

    const assistantId = `assistant-${Date.now()}`;
    setDisplayMessages(prev => [...prev, {
      id: assistantId, role: 'assistant', text: '', actions: [], isStreaming: true,
    }]);

    const onEvent = (event: StreamEvent) => {
      switch (event.type) {
        case 'text':
          setDisplayMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, text: m.text + event.text } : m
          ));
          break;
        case 'tool_start':
          setDisplayMessages(prev => prev.map(m =>
            m.id === assistantId
              ? { ...m, actions: [...m.actions, `⚙ ${TOOL_LABELS[event.toolName] ?? event.toolName}…`] }
              : m
          ));
          break;
        case 'tool_done':
          setDisplayMessages(prev => prev.map(m => {
            if (m.id !== assistantId) return m;
            const prefix = event.result.startsWith('Error') ? '✗' : '✓';
            const summary = event.result.length > 72 ? event.result.slice(0, 70) + '…' : event.result;
            const updated = [...m.actions];
            updated[updated.length - 1] = `${prefix} ${summary}`;
            return { ...m, actions: updated };
          }));
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

    const updatedHistory = await runAgentTurn(
      apiKey, effectiveModelId, baseUrl, apiHistory.current, onEvent, handleToolCall,
    );
    apiHistory.current = updatedHistory;
  }, [input, isProcessing, apiKey, effectiveModelId, baseUrl, handleToolCall]);

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
            {/* Row 1: API key */}
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

            {/* Row 2: model + base URL */}
            <div className="flex items-center gap-2">
              <select
                value={modelId}
                onChange={e => saveModel(e.target.value)}
                className="bg-slate-800 text-xs text-slate-300 rounded px-2 py-1 outline-none border border-slate-700 cursor-pointer shrink-0"
              >
                {MODEL_OPTIONS.map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
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
                Ask me to build a circuit, explain gates, or modify your current circuit.
              </p>
            ) : (
              displayMessages.map(msg => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[86%] rounded-lg px-3 py-1.5 text-xs leading-relaxed ${
                    msg.role === 'user' ? 'bg-blue-700 text-white' : 'bg-slate-800 text-slate-200'
                  }`}>
                    {msg.text && <p className="whitespace-pre-wrap">{msg.text}</p>}
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
              placeholder={apiKey ? 'Ask me to build a circuit…' : 'Enter an API key above to get started'}
              disabled={isProcessing || !apiKey}
              className="flex-1 bg-slate-800 text-xs text-white rounded px-3 py-1.5 outline-none border border-slate-700 focus:border-blue-500 placeholder:text-slate-600 disabled:opacity-50 transition-colors"
            />
            <button
              onClick={handleSend}
              disabled={isProcessing || !input.trim() || !apiKey || !effectiveModelId}
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
