/**
 * Header control for the MCP bridge.
 *
 * Off by default — opening a socket that lets another process rewrite the canvas should be
 * a deliberate act. Once on, it shows the pairing code, which is only needed when more
 * than one HyQSim tab is open (with one tab, the MCP server auto-pairs).
 */

import { useState } from 'react';
import type { SessionStatus } from '../mcp/session';

interface McpSessionBadgeProps {
  enabled: boolean;
  status: SessionStatus;
  code: string | null;
  error?: string;
  onToggle: (enabled: boolean) => void;
}

const STATUS_STYLES: Record<SessionStatus, { dot: string; label: string }> = {
  disabled:   { dot: 'bg-slate-600',                    label: 'AI Connect' },
  connecting: { dot: 'bg-amber-400 animate-pulse',      label: 'Connecting…' },
  connected:  { dot: 'bg-emerald-400',                  label: 'AI Connected' },
  error:      { dot: 'bg-red-500',                      label: 'Connection failed' },
};

export default function McpSessionBadge({
  enabled, status, code, error, onToggle,
}: McpSessionBadgeProps) {
  const [showHelp, setShowHelp] = useState(false);
  const style = STATUS_STYLES[status];

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <button
          onClick={() => onToggle(!enabled)}
          title={
            enabled
              ? 'Disconnect the canvas from external AI clients'
              : 'Let Claude Desktop or Claude Code drive this canvas over MCP'
          }
          className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border transition-colors ${
            enabled
              ? 'bg-slate-800 border-slate-600 text-slate-200 hover:border-slate-500'
              : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600'
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />
          {style.label}
          {status === 'connected' && code && (
            <span className="font-mono text-emerald-300 ml-0.5">{code}</span>
          )}
        </button>

        <button
          onClick={() => setShowHelp(v => !v)}
          className="text-[11px] w-5 h-5 rounded-full border border-slate-700 text-slate-500 hover:text-slate-200 hover:border-slate-600 transition-colors"
          title="How to connect an AI client"
        >
          ?
        </button>
      </div>

      {showHelp && (
        <div className="absolute right-0 top-8 z-50 w-96 bg-slate-900 border border-slate-700 rounded-lg shadow-xl p-3 text-[11px] text-slate-300 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold text-white">Drive HyQSim from Claude</p>
            <button
              onClick={() => setShowHelp(false)}
              className="text-slate-500 hover:text-slate-200 shrink-0 leading-none"
            >
              ✕
            </button>
          </div>

          <p className="text-slate-400">
            Uses your own Claude subscription instead of an API key — no tokens are billed
            to this app.
          </p>

          <p className="text-slate-400">Add this to your Claude Desktop config, then restart it:</p>
          <pre className="bg-slate-950 rounded p-2 overflow-x-auto text-[10px] font-mono text-emerald-300 leading-relaxed">
{`{
  "mcpServers": {
    "hyqsim": {
      "command": "python3",
      "args": ["<repo>/backend/mcp_server.py"]
    }
  }
}`}
          </pre>

          <p className="text-slate-400">Or, for Claude Code:</p>
          <pre className="bg-slate-950 rounded p-2 overflow-x-auto text-[10px] font-mono text-emerald-300">
            claude mcp add hyqsim -- python3 &lt;repo&gt;/backend/mcp_server.py
          </pre>

          <p className="text-slate-400">
            Then ask it to <span className="text-slate-200">"build a 4-qubit GHZ in HyQSim"</span>{' '}
            and watch this canvas.
          </p>

          {code && (
            <p className="text-slate-500 border-t border-slate-800 pt-2">
              Session <span className="font-mono text-slate-300">{code}</span>. You only need
              this code if more than one HyQSim tab is open — otherwise pairing is automatic.
            </p>
          )}

          <p className="text-slate-500 border-t border-slate-800 pt-2">
            Requires the backend running:{' '}
            <span className="font-mono text-slate-400">uvicorn main:app --port 8000</span>
          </p>
        </div>
      )}

      {status === 'error' && error && (
        <div className="absolute right-0 top-8 z-40 w-80 bg-red-950 border border-red-800 rounded p-2 text-[10px] text-red-200">
          {error}
        </div>
      )}
    </div>
  );
}
