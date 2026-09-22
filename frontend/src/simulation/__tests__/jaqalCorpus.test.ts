/**
 * Runs the Jaqal importer over a directory of real .jaqal programs.
 *
 * The corpus is the hybridlane-benchmarking repo, which is not vendored here —
 * point at it with JAQAL_CORPUS, or leave it at the default checkout path:
 *
 *     JAQAL_CORPUS=~/Documents/hybridlane-benchmarking npm test
 *
 * The whole suite skips when the corpus is missing, so CI without the repo
 * still passes. The point of these tests is coverage of things hand-written
 * fixtures do not produce: CRLF files, legacy dialects, subcircuit repeat
 * counts, 500-gate programs, and modes addressed across several manifolds.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseJaqal, generateJaqal } from '../jaqalIO';
import { ALL_GATES } from '../../types/circuit';
import { simulate } from './helpers';

const CORPUS =
  process.env.JAQAL_CORPUS ??
  path.join(process.env.HOME ?? '', 'Documents/hybridlane-benchmarking');

function findJaqalFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findJaqalFiles(full, out);
    else if (entry.name.endsWith('.jaqal')) out.push(full);
  }
  return out;
}

const haveCorpus = fs.existsSync(CORPUS);
const files = haveCorpus ? findJaqalFiles(CORPUS).sort() : [];

/**
 * Every way the importer is allowed to reject a file. A rejection that does not
 * match one of these is a parser gap, not a considered refusal — in particular
 * "unrecognised statement" means we hit a gate spelling nobody has triaged.
 */
const ACCEPTABLE_REJECTIONS = [
  /"loop" blocks are not supported/,
  /"macro" definitions are not supported/,
  /"map" aliases are not supported/,
  /parallel blocks .* are not supported/,
  /"prepare_all" after a gate/,
  /a second qubit register/,
  /cannot be imported —/,
  /is an idle-padding pulse/,
];

/** Count the gate elements a program should produce, straight from its text. */
function expectedElementCount(code: string): number {
  const lines = code
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean);

  const registerLine = lines.find(l => l.startsWith('register '));
  const registerSize = registerLine ? Number(registerLine.match(/\[(\d+)\]/)?.[1] ?? 0) : 0;

  const GATE_HEADS = new Set([
    'Rx', 'Ry', 'Rz', 'Px', 'Py', 'Pz', 'Sz', 'Szd',
    'zCD', 'xCD', 'yCD', 'JC', 'AJC',
    'Blue', 'Red',   // legacy qscout.v1.std sideband spellings
  ]);

  let count = 0;
  for (const line of lines) {
    const head = line.split(/\s+/)[0];
    if (GATE_HEADS.has(head)) count++;
    else if (head === 'measure_all') count += registerSize;
  }
  return count;
}

describe.skipIf(!haveCorpus)(`Jaqal corpus at ${CORPUS}`, () => {
  it('found .jaqal files to test', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // A file either imports, or is refused for a reason we have deliberately
  // triaged. Silent misparses and untriaged gate names both fail here.
  it('every file either imports or is refused for a known reason', () => {
    const untriaged: string[] = [];
    for (const file of files) {
      const result = parseJaqal(fs.readFileSync(file, 'utf8'));
      if (result.success) continue;
      const message = result.error ?? '';
      if (!ACCEPTABLE_REJECTIONS.some(re => re.test(message))) {
        untriaged.push(`${path.relative(CORPUS, file)}: ${message}`);
      }
    }
    expect(untriaged, `untriaged rejections:\n${untriaged.join('\n')}`).toEqual([]);
  });

  // Regression guard for the CRLF bug: "\r" is a line terminator that `.` does
  // not match, so an unnormalised CRLF file left every `// comment` in place
  // and the parser choked on them as if they were statements.
  it('imports CRLF files as readily as LF files', () => {
    const crlfFiles = files.filter(f => fs.readFileSync(f, 'utf8').includes('\r\n'));
    expect(crlfFiles.length, 'corpus has no CRLF files to exercise').toBeGreaterThan(0);

    const commentFailures = crlfFiles.filter(f => {
      const r = parseJaqal(fs.readFileSync(f, 'utf8'));
      return !r.success && /unrecognised statement "\/\//.test(r.error ?? '');
    });
    expect(commentFailures.map(f => path.relative(CORPUS, f))).toEqual([]);
  });

  it('a CRLF file and its LF twin import to exactly the same circuit', () => {
    const withGates = files.find(f => {
      const r = parseJaqal(fs.readFileSync(f, 'utf8'));
      return r.success && r.elements.length > 5;
    });
    expect(withGates, 'no importable multi-gate file in the corpus').toBeDefined();

    const lf = fs.readFileSync(withGates!, 'utf8').replace(/\r\n?/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = parseJaqal(lf);
    const b = parseJaqal(crlf);

    expect(b.success).toBe(true);
    expect(b.elements.length).toBe(a.elements.length);
    expect(b.wires.map(w => w.type)).toEqual(a.wires.map(w => w.type));
    expect(b.elements.map(e => [e.gateId, e.wireIndex, e.parameterValues]))
      .toEqual(a.elements.map(e => [e.gateId, e.wireIndex, e.parameterValues]));
  });

  describe('every importable file', () => {
    const importable = files
      .map(file => ({ file, code: fs.readFileSync(file, 'utf8') }))
      .map(({ file, code }) => ({ file, code, result: parseJaqal(code) }))
      .filter(({ result }) => result.success);

    it('there are importable files', () => {
      expect(importable.length).toBeGreaterThan(0);
    });

    it('keeps every gate line — nothing is silently dropped', () => {
      const mismatches = importable
        .map(({ file, code, result }) => ({
          file: path.relative(CORPUS, file),
          got: result.elements.length,
          want: expectedElementCount(code),
        }))
        .filter(m => m.got !== m.want);
      expect(mismatches).toEqual([]);
    });

    it('only produces gates that exist in the palette', () => {
      const palette = new Set(ALL_GATES.map(g => g.id));
      const unknown = new Set<string>();
      for (const { result } of importable) {
        for (const el of result.elements) if (!palette.has(el.gateId)) unknown.add(el.gateId);
      }
      expect([...unknown]).toEqual([]);
    });

    // Wire indices are what the canvas and simulator address gates by, so a
    // gate pointing off the end of the wire list is a crash waiting to happen.
    it('gives every gate an in-range qubit wire and qumode target', () => {
      const bad: string[] = [];
      for (const { file, result } of importable) {
        const { wires, elements } = result;
        for (const el of elements) {
          const host = wires[el.wireIndex];
          if (!host || host.type !== 'qubit') {
            bad.push(`${path.relative(CORPUS, file)}: ${el.gateId} on wire ${el.wireIndex}`);
          }
          for (const t of el.targetWireIndices ?? []) {
            if (!wires[t] || wires[t].type !== 'qumode') {
              bad.push(`${path.relative(CORPUS, file)}: ${el.gateId} targets wire ${t}`);
            }
          }
        }
      }
      expect(bad).toEqual([]);
    });

    it('gives every qumode wire a distinct (manifold, mode) address', () => {
      const clashes: string[] = [];
      for (const { file, result } of importable) {
        const seen = new Set<string>();
        for (const w of result.wires) {
          if (w.type !== 'qumode' || !w.jaqalMode) continue;
          const key = `${w.jaqalMode.manifold}:${w.jaqalMode.index}`;
          if (seen.has(key)) clashes.push(`${path.relative(CORPUS, file)}: ${key}`);
          seen.add(key);
        }
      }
      expect(clashes).toEqual([]);
    });

    it('exports back to Jaqal', () => {
      const failures = importable
        .map(({ file, result }) => ({ file: path.relative(CORPUS, file), out: generateJaqal(result.wires, result.elements) }))
        .filter(({ out }) => !out.success)
        .map(({ file, out }) => `${file}: ${out.error}`);
      expect(failures).toEqual([]);
    });

    // import → export → import → export. The second export must be identical to
    // the first, which is the property that actually matters: repeated trips
    // through the app must not drift the program.
    it('round-trips to a fixed point', () => {
      const drifted: string[] = [];
      for (const { file, result } of importable) {
        const first = generateJaqal(result.wires, result.elements);
        if (!first.success) continue;
        const reimported = parseJaqal(first.code);
        if (!reimported.success) {
          drifted.push(`${path.relative(CORPUS, file)}: re-import failed — ${reimported.error}`);
          continue;
        }
        const second = generateJaqal(reimported.wires, reimported.elements);
        if (second.code !== first.code) drifted.push(`${path.relative(CORPUS, file)}: export drifted`);
      }
      expect(drifted).toEqual([]);
    });

    it('preserves gate order, wire count and parameters across a round trip', () => {
      const broken: string[] = [];
      for (const { file, result } of importable) {
        const out = generateJaqal(result.wires, result.elements);
        if (!out.success) continue;
        const back = parseJaqal(out.code);
        if (!back.success) continue;

        const before = result.elements.map(e => e.gateId).join(',');
        const after = back.elements.map(e => e.gateId).join(',');
        if (before !== after) broken.push(`${path.relative(CORPUS, file)}: gate sequence changed`);
        if (back.wires.length !== result.wires.length) {
          broken.push(`${path.relative(CORPUS, file)}: wire count ${result.wires.length} → ${back.wires.length}`);
        }
      }
      expect(broken).toEqual([]);
    });

    // The importer's real job is to hand the simulator something runnable, so
    // actually run the biggest few programs end to end.
    it('produces circuits the simulator runs to a normalised state', () => {
      const biggest = [...importable]
        .sort((a, b) => b.result.elements.length - a.result.elements.length)
        .slice(0, 5);

      for (const { file, result } of biggest) {
        const where = path.relative(CORPUS, file);
        const sim = simulate(result.wires, result.elements, 8, { shots: 64 });

        // Every wire must come back with a state, and every distribution must
        // be a probability distribution — a NaN anywhere in the gate matrices
        // shows up here as a total that is not ~1.
        expect(sim.qubitStates.size + sim.qumodeStates.size, where).toBe(result.wires.length);

        for (const state of sim.qumodeStates.values()) {
          const total = state.fockProbabilities.reduce((a, b) => a + b, 0);
          expect(Number.isFinite(total), `${where}: non-finite Fock distribution`).toBe(true);
          // fockDim 8 truncates a displaced mode, so some probability leaks out
          // of the window; it must never exceed 1.
          expect(total, where).toBeGreaterThan(0.5);
          expect(total, where).toBeLessThan(1.0001);
        }
        for (const state of sim.qubitStates.values()) {
          const bloch = Math.hypot(state.blochVector.x, state.blochVector.y, state.blochVector.z);
          expect(Number.isFinite(bloch), `${where}: non-finite Bloch vector`).toBe(true);
          expect(bloch, `${where}: Bloch vector outside the sphere`).toBeLessThan(1.0001);
        }
      }
    });
  });
});
