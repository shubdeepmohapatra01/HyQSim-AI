/**
 * Exposes the repo's verified benchmark circuits to the AI.
 *
 * Why this exists: a language model asked for a "cat state" will confidently produce
 * H → CD → done, which is an aborted preparation — it leaves the qubit entangled with the
 * mode and never closes the interferometer. The correct construction is eight gates
 * (`benchmarks/circuits.ts:catStateCircuit`), and no amount of prompt-tuning makes a model
 * reliably reproduce it from memory.
 *
 * So it does not have to. These circuits are already in the codebase, already verified,
 * and already parameterised. The assistant loads them instead of improvising, and only
 * falls back to building from scratch for things HyQSim has no reference for.
 */

import { BENCHMARKS, type BenchmarkCircuit } from '../benchmarks/circuits';

export interface BenchmarkSummary {
  id: string;
  name: string;
  description: string;
  params: { name: string; label: string; defaultValue: number }[];
}

export function listBenchmarks(): BenchmarkSummary[] {
  return BENCHMARKS.map(b => ({
    id: b.id,
    name: b.name,
    description: b.description,
    params: (b.params ?? []).map(p => ({
      name: p.name,
      label: p.label,
      defaultValue: p.defaultValue,
    })),
  }));
}

/**
 * One line per benchmark for the system prompt. Kept terse — this is paid for on every
 * request, and the detail lives in the tool result instead.
 */
export function encodeBenchmarkReference(): string {
  return BENCHMARKS.map(b => {
    const params = (b.params ?? []).map(p => `${p.name}=${Number(p.defaultValue.toFixed(3))}`).join(', ');
    return `${b.id}: ${b.description}${params ? ` (${params})` : ''}`;
  }).join('\n');
}

/** Terms that should make the assistant reach for a benchmark rather than improvise. */
export const BENCHMARK_KEYWORDS: Record<string, string[]> = {
  'cat-state': ['cat state', 'cat-state', 'schrodinger cat', 'schrödinger cat', 'kitten'],
  'cv-to-dv': ['cv to dv', 'cv→dv', 'qumode to qubit', 'state transfer'],
  'dv-to-cv': ['dv to cv', 'dv→cv', 'qubit to qumode', 'state transfer'],
};

/** Returns the benchmark id a request is asking for, if any. */
export function benchmarkForPrompt(prompt: string): string | null {
  const p = prompt.toLowerCase();
  for (const [id, keywords] of Object.entries(BENCHMARK_KEYWORDS)) {
    if (keywords.some(k => p.includes(k))) return id;
  }
  return null;
}

export function buildBenchmark(
  id: string,
  params?: Record<string, number>,
): { circuit: BenchmarkCircuit; error: null } | { circuit: null; error: string } {
  const benchmark = BENCHMARKS.find(b => b.id === id);
  if (!benchmark) {
    return {
      circuit: null,
      error: `Unknown benchmark "${id}". Available: ${BENCHMARKS.map(b => b.id).join(', ')}`,
    };
  }

  const declared = benchmark.params ?? [];
  for (const key of Object.keys(params ?? {})) {
    if (!declared.some(p => p.name === key)) {
      return {
        circuit: null,
        error: `Benchmark "${id}" has no parameter "${key}". Valid: ${declared.map(p => p.name).join(', ') || 'none'}`,
      };
    }
  }

  try {
    return { circuit: benchmark.build(params), error: null };
  } catch (e) {
    return { circuit: null, error: `Failed to build "${id}": ${e instanceof Error ? e.message : String(e)}` };
  }
}
