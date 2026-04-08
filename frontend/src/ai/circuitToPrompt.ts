import type { Wire, CircuitElement } from '../types/circuit';
import { ALL_GATES } from '../types/circuit';

const _gatesMap = new Map(ALL_GATES.map(g => [g.id, g]));

/** Returns the human-readable label for a wire, e.g. "q0", "m1". */
export function wireLabel(wires: Wire[], idx: number): string {
  const wire = wires[idx];
  if (!wire) return `wire${idx}`;
  const typeCount = wires.slice(0, idx).filter(w => w.type === wire.type).length;
  return wire.type === 'qubit' ? `q${typeCount}` : `m${typeCount}`;
}

/** Converts a wire label like "q0" or "m1" to its index in the wires array. Returns -1 if not found. */
export function wireLabelToIndex(wires: Wire[], label: string): number {
  const match = label.match(/^([qm])(\d+)$/);
  if (!match) return -1;
  const type = match[1] === 'q' ? 'qubit' : 'qumode';
  const n = parseInt(match[2], 10);
  let count = 0;
  for (let i = 0; i < wires.length; i++) {
    if (wires[i].type === type) {
      if (count === n) return i;
      count++;
    }
  }
  return -1;
}

/** Serializes the current circuit to a readable text description for the AI. */
export function circuitToPrompt(wires: Wire[], elements: CircuitElement[]): string {
  if (wires.length === 0) return 'Circuit is empty (no wires or gates).';

  const qubitWires = wires.filter(w => w.type === 'qubit');
  const qumodeWires = wires.filter(w => w.type === 'qumode');

  const lines: string[] = [
    `Circuit: ${qubitWires.length} qubit(s), ${qumodeWires.length} qumode(s).`,
    'Wires:',
    ...wires.map((w, i) => {
      const label = wireLabel(wires, i);
      const state = w.initialState ?? (w.type === 'qubit' ? '0' : 0);
      return `  ${label} (${w.type}): initial |${state}⟩`;
    }),
  ];

  if (elements.length === 0) {
    lines.push('No gates placed.');
    return lines.join('\n');
  }

  const sorted = [...elements].sort((a, b) => a.position.x - b.position.x);
  lines.push(`Gates (${sorted.length} total, left to right):`);
  sorted.forEach((el, i) => {
    const gate = _gatesMap.get(el.gateId);
    const name = gate?.name ?? el.gateId;
    const primary = wireLabel(wires, el.wireIndex);
    const targets = el.targetWireIndices?.map(t => wireLabel(wires, t)).join(', ');
    const params = el.parameterValues
      ? Object.entries(el.parameterValues).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(', ')
      : '';
    let desc = `  ${i + 1}. [${el.id}] ${name} on ${primary}`;
    if (targets) desc += ` → ${targets}`;
    if (params) desc += ` (${params})`;
    lines.push(desc);
  });

  return lines.join('\n');
}
