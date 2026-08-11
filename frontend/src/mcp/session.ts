/**
 * Live canvas session — the browser end of the MCP bridge.
 *
 * When connected, an external AI client (Claude Desktop, Claude Code) can build circuits
 * that appear on this canvas in real time, and can ask this tab to run HyQSim's simulator.
 *
 * The tab remains authoritative for simulation: `run_simulation` messages are executed
 * locally with the user's selected backend and Fock truncation, and the result is sent
 * back. The AI never computes physics.
 *
 * Opt-in: nothing connects unless the user enables it, and the setting persists.
 */

import type { Wire, CircuitElement, SimulationResult } from '../types/circuit';

const BACKEND_URL = import.meta.env?.VITE_BACKEND_URL || 'http://localhost:8000';

export type SessionStatus = 'disabled' | 'connecting' | 'connected' | 'error';

export interface SessionHandlers {
  /** An external client changed the circuit. Replace canvas state with this. */
  onCircuit: (wires: Wire[], elements: CircuitElement[]) => void;
  /** An external client asked for results. Run the simulator and return what it produced. */
  onRunSimulation: () => Promise<SimulationResult | null>;
  onStatusChange: (status: SessionStatus, code: string | null, error?: string) => void;
}

/** SimulationResult carries Maps, which do not survive JSON. Convert for the wire. */
function serializeResult(result: SimulationResult): unknown {
  return {
    ...result,
    qubitStates: Object.fromEntries(result.qubitStates),
    qumodeStates: Object.fromEntries(result.qumodeStates),
  };
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 30_000;

export class CanvasSession {
  private socket: WebSocket | null = null;
  private code: string | null = null;
  private handlers: SessionHandlers;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Suppresses the echo of a circuit we just received from the server. */
  private applyingRemote = false;

  constructor(handlers: SessionHandlers) {
    this.handlers = handlers;
  }

  get sessionCode(): string | null {
    return this.code;
  }

  async connect(existingCode?: string): Promise<void> {
    this.closedByUser = false;
    this.handlers.onStatusChange('connecting', this.code);

    try {
      if (!existingCode) {
        const response = await fetch(`${BACKEND_URL}/session`, { method: 'POST' });
        if (!response.ok) throw new Error(`Backend returned ${response.status}`);
        this.code = (await response.json()).code;
      } else {
        this.code = existingCode;
      }
      this.openSocket();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.handlers.onStatusChange(
        'error', this.code,
        `Cannot reach the HyQSim backend at ${BACKEND_URL}. Start it with: cd backend && uvicorn main:app --port 8000 (${message})`,
      );
      this.scheduleReconnect();
    }
  }

  private openSocket(): void {
    if (!this.code) return;
    const wsUrl = `${BACKEND_URL.replace(/^http/, 'ws')}/session/${this.code}/ws`;
    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.handlers.onStatusChange('connected', this.code);
      this.pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
      }, PING_INTERVAL_MS);
    };

    socket.onmessage = async (event) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === 'circuit') {
        this.applyingRemote = true;
        try {
          this.handlers.onCircuit(
            (message.wires ?? []) as Wire[],
            (message.elements ?? []) as CircuitElement[],
          );
        } finally {
          // Cleared on a macrotask so the React state update it triggered has flushed
          // before we start echoing local edits again.
          setTimeout(() => { this.applyingRemote = false; }, 0);
        }
        return;
      }

      if (message.type === 'run_simulation') {
        const result = await this.handlers.onRunSimulation();
        socket.send(JSON.stringify({
          type: 'simulation',
          requestId: message.requestId,
          result: result ? serializeResult(result) : null,
        }));
      }
    };

    socket.onclose = () => {
      this.clearPing();
      this.socket = null;
      if (!this.closedByUser) {
        this.handlers.onStatusChange('connecting', this.code);
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      // onclose always follows, and handles reconnection.
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Reuse the existing code so an AI client mid-conversation keeps its session.
      this.connect(this.code ?? undefined);
    }, delay);
  }

  /** Pushes a local canvas edit up so an external client sees the user's changes. */
  pushCircuit(
    wires: Wire[], elements: CircuitElement[], fockTruncation: number, backend: string,
  ): void {
    if (this.applyingRemote) return;
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: 'circuit', wires, elements, fockTruncation, backend }));
  }

  pushSettings(fockTruncation: number, backend: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: 'settings', fockTruncation, backend }));
  }

  /** Sends a result the user produced by pressing Run, so the AI sees it without re-running. */
  pushResult(result: SimulationResult): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: 'simulation', result: serializeResult(result) }));
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  disconnect(): void {
    this.closedByUser = true;
    this.clearPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.handlers.onStatusChange('disabled', null);
  }
}
