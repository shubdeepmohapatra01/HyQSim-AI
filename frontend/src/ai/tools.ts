import type { Gate, Wire, CircuitElement } from '../types/circuit';
import { ALL_GATES, getDefaultParameters } from '../types/circuit';
import { wireLabelToIndex } from './circuitToPrompt';

const _gatesMap = new Map(ALL_GATES.map(g => [g.id, g]));

const GATE_REFERENCE = ALL_GATES.map(g => {
  const params = g.parameters?.map(p => `${p.name}=${p.defaultValue}`).join(', ');
  return `  ${g.id}: ${g.name}${params ? ` (params: ${params})` : ''}`;
}).join('\n');

export const SYSTEM_PROMPT = `You are a quantum circuit assistant for HyQSim, a hybrid CV-DV (continuous-variable / discrete-variable) quantum circuit simulator.

Help users build and understand hybrid quantum circuits. When building or modifying a circuit, use the provided tools.

Available gates:
${GATE_REFERENCE}

Wire naming: qubits → q0, q1, ...; qumodes (bosonic modes) → m0, m1, ...

Multi-wire gate rules:
- cnot: wireLabel=control qubit, targetWireLabel=target qubit
- bs (beam splitter): wireLabel=first qumode, targetWireLabel=second qumode
- cdisp, xcdisp, ycdisp (conditional displacement): wireLabel=qubit, targetWireLabel=qumode
- cr (conditional rotation): wireLabel=qubit, targetWireLabel=qumode
- jc (Jaynes-Cummings): wireLabel=qubit, targetWireLabel=qumode

When building a circuit from scratch: call add_wire to create the wires first, then add_gate.
When asked to explain or describe the current circuit: call read_circuit first.
Angles are in radians (π ≈ 3.14159, π/2 ≈ 1.5708, π/4 ≈ 0.7854).
For cat state circuits: use H on qubit, then cdisp (conditional displacement) coupling qubit to qumode.`;

export const AI_TOOLS = [
  {
    name: 'read_circuit',
    description: 'Get the current circuit state as a readable description.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'add_wire',
    description: 'Add a new wire to the circuit.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['qubit', 'qumode'], description: 'Wire type' },
      },
      required: ['type'],
    },
  },
  {
    name: 'add_gate',
    description: 'Place a gate on the circuit.',
    input_schema: {
      type: 'object' as const,
      properties: {
        gateId: { type: 'string', description: 'Gate ID from the available gates list (e.g. "h", "x", "displace", "cdisp")' },
        wireLabel: { type: 'string', description: 'Primary wire label, e.g. "q0" or "m0"' },
        targetWireLabel: { type: 'string', description: 'Second wire label for multi-wire gates (cnot, bs, cdisp, cr, jc, etc.)' },
        parameters: {
          type: 'object',
          description: 'Gate parameter overrides as key-value pairs (e.g. {"theta": 1.5708}). Omit to use defaults.',
          additionalProperties: { type: 'number' },
        },
      },
      required: ['gateId', 'wireLabel'],
    },
  },
  {
    name: 'remove_gate',
    description: 'Remove a gate from the circuit by its element ID (shown in read_circuit output).',
    input_schema: {
      type: 'object' as const,
      properties: {
        elementId: { type: 'string', description: 'Element ID from read_circuit, e.g. "element-1234"' },
      },
      required: ['elementId'],
    },
  },
  {
    name: 'clear_circuit',
    description: 'Remove all gates and wires from the circuit.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
];

export type CircuitMutation =
  | { type: 'add_wire'; wireType: 'qubit' | 'qumode' }
  | { type: 'add_gate'; gate: Gate; wireIndex: number; position: { x: number; y: number }; targetWireIndices?: number[]; parameterValues?: Record<string, number> }
  | { type: 'remove_gate'; elementId: string }
  | { type: 'clear_circuit' }
  | { type: 'read_circuit' };

export function parseToolCall(
  name: string,
  input: Record<string, unknown>,
  wires: Wire[],
  elements: CircuitElement[],
): { mutation: CircuitMutation; error: null } | { mutation: null; error: string } {
  switch (name) {
    case 'read_circuit':
      return { mutation: { type: 'read_circuit' }, error: null };

    case 'clear_circuit':
      return { mutation: { type: 'clear_circuit' }, error: null };

    case 'add_wire': {
      const wt = input.type as string;
      if (wt !== 'qubit' && wt !== 'qumode') {
        return { mutation: null, error: `Invalid wire type: "${input.type}". Must be "qubit" or "qumode".` };
      }
      return { mutation: { type: 'add_wire', wireType: wt }, error: null };
    }

    case 'remove_gate': {
      const eid = input.elementId as string;
      if (!elements.some(e => e.id === eid)) {
        return { mutation: null, error: `No gate with id "${eid}". Call read_circuit to get current element IDs.` };
      }
      return { mutation: { type: 'remove_gate', elementId: eid }, error: null };
    }

    case 'add_gate': {
      const gateId = input.gateId as string;
      const gate = _gatesMap.get(gateId);
      if (!gate) {
        return { mutation: null, error: `Unknown gate id: "${gateId}". Valid IDs: ${[..._gatesMap.keys()].join(', ')}` };
      }

      const wl = input.wireLabel as string;
      const wireIndex = wireLabelToIndex(wires, wl);
      if (wireIndex === -1) {
        return { mutation: null, error: `Wire "${wl}" not found. Current wires: ${wires.length === 0 ? 'none (call add_wire first)' : wires.map((_, i) => { const w = wires[i]; const tc = wires.slice(0, i).filter(x => x.type === w.type).length; return w.type === 'qubit' ? `q${tc}` : `m${tc}`; }).join(', ')}` };
      }

      let targetWireIndices: number[] | undefined;
      if (input.targetWireLabel) {
        const tl = input.targetWireLabel as string;
        const ti = wireLabelToIndex(wires, tl);
        if (ti === -1) {
          return { mutation: null, error: `Target wire "${tl}" not found.` };
        }
        targetWireIndices = [ti];
      }

      const wire = wires[wireIndex];
      if (gate.category === 'qubit' && !gate.numQumodes && wire.type !== 'qubit') {
        return { mutation: null, error: `Gate "${gateId}" requires a qubit wire, but "${wl}" is a qumode.` };
      }
      if (gate.category === 'qumode' && !gate.numQubits && wire.type !== 'qumode') {
        return { mutation: null, error: `Gate "${gateId}" requires a qumode wire, but "${wl}" is a qubit.` };
      }

      const defaults = getDefaultParameters(gate);
      const overrides = (input.parameters as Record<string, number>) ?? {};
      const parameterValues = { ...defaults, ...overrides };

      const maxX = elements.length > 0 ? Math.max(...elements.map(e => e.position.x)) : -60;
      const position = { x: maxX + 80, y: 0 };

      return {
        mutation: { type: 'add_gate', gate, wireIndex, position, targetWireIndices, parameterValues },
        error: null,
      };
    }

    default:
      return { mutation: null, error: `Unknown tool: "${name}"` };
  }
}
