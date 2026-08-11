import { useEffect, useRef, useState } from 'react';
import type { QumodeState } from '../types/circuit';
import {
  computeWignerFunction,
  computeWignerFromDensityMatrix,
  computeQuadratureExpectations,
} from '../simulation/wigner';

type DisplayMode = 'fock' | 'wigner' | 'xdist' | 'pdist';

const FOCK_DEFAULT = 15;
const FOCK_MIN = 5;
const FOCK_STEP = 5;
const FOCK_HARD_MAX = 200;

const RANGE_DEFAULT = 6;
const RANGE_MIN = 2;
const RANGE_MAX = 14;
const RANGE_STEP = 2;

const DIST_GRID = 200; // points for 1-D quadrature distributions

interface QumodeDisplayProps {
  qumodeIndex: number;
  wireIndex: number;
  fockTruncation: number;
  state?: QumodeState;
}

export default function QumodeDisplay({
  qumodeIndex,
  wireIndex,
  fockTruncation,
  state,
}: QumodeDisplayProps) {
  const [mode, setMode] = useState<DisplayMode>('fock');
  const [fockShow, setFockShow] = useState(FOCK_DEFAULT);
  const [range, setRange] = useState(RANGE_DEFAULT);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const fockProbabilities = state?.fockProbabilities ?? createVacuumProbabilities(fockTruncation);
  const fockAmplitudes    = state?.fockAmplitudes    ?? createVacuumAmplitudes(fockTruncation);
  const meanPhotonNumber  = state?.meanPhotonNumber  ?? 0;
  const precomputedWigner = state?.wignerData;
  const backendRange      = state?.wignerRange ?? RANGE_DEFAULT;
  const densityMatrix     = state?.densityMatrix;

  // Quadrature expectations — always computed for the footer
  const { xMean, pMean } = computeQuadratureExpectations(fockAmplitudes);

  const maxFockShow       = Math.min(FOCK_HARD_MAX, fockTruncation);
  const effectiveFockShow = Math.min(fockShow, maxFockShow);
  const fockMaxProb       = Math.max(...fockProbabilities.slice(0, effectiveFockShow), 0.001);
  const xLabelStep        = effectiveFockShow <= 20 ? 1 : effectiveFockShow <= 50 ? 5 : effectiveFockShow <= 100 ? 10 : 25;

  // Render Wigner canvas whenever mode, state, or range changes
  useEffect(() => {
    if (mode !== 'wigner' || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let wigner: number[][];
    if (precomputedWigner && precomputedWigner.length > 0 && range === backendRange) {
      wigner = precomputedWigner;
    } else if (densityMatrix && densityMatrix.length > 0) {
      wigner = computeWignerFromDensityMatrix(densityMatrix, 80, range);
    } else {
      wigner = computeWignerFunction(fockAmplitudes, 80, range);
    }

    const size = wigner.length;
    let minVal = Infinity, maxVal = -Infinity;
    for (let i = 0; i < size; i++)
      for (let j = 0; j < size; j++)
        if (isFinite(wigner[i][j])) {
          minVal = Math.min(minVal, wigner[i][j]);
          maxVal = Math.max(maxVal, wigner[i][j]);
        }
    const absMax = Math.max(Math.abs(minVal), Math.abs(maxVal), 0.01);
    const scaleX = canvas.width / size;
    const scaleY = canvas.height / size;

    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const v = wigner[i][j] / absMax;
        let r, g, b;
        if (v >= 0) {
          const t = Math.min(1, v);
          r = g = Math.floor(255 * (1 - t * 0.8)); b = 255;
        } else {
          const t = Math.min(1, -v);
          r = 255; g = b = Math.floor(255 * (1 - t * 0.8));
        }
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(i * scaleX, (size - 1 - j) * scaleY, scaleX + 1, scaleY + 1);
      }
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, 0); ctx.lineTo(canvas.width / 2, canvas.height);
    ctx.moveTo(0, canvas.height / 2); ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }, [mode, fockAmplitudes, precomputedWigner, densityMatrix, range, backendRange]);

  // Range zoom controls (shared by Wigner, x-dist, p-dist)
  const zoomControls = (
    <div className="flex items-center justify-center gap-2 mt-2">
      <button
        onClick={() => setRange(r => Math.max(RANGE_MIN, r - RANGE_STEP))}
        disabled={range <= RANGE_MIN}
        className="px-1.5 py-0.5 text-[10px] bg-slate-700 hover:bg-slate-600 disabled:opacity-30 rounded text-slate-300"
      >zoom in</button>
      <span className="text-[9px] text-slate-500">±{range}</span>
      <button
        onClick={() => setRange(r => Math.min(RANGE_MAX, r + RANGE_STEP))}
        disabled={range >= RANGE_MAX}
        className="px-1.5 py-0.5 text-[10px] bg-slate-700 hover:bg-slate-600 disabled:opacity-30 rounded text-slate-300"
      >zoom out</button>
    </div>
  );

  return (
    <div className="bg-slate-800 rounded-lg p-3">
      {/* Header */}
      <div className="flex justify-between items-center mb-2">
        <h4 className="text-sm font-semibold text-emerald-400">
          |m{qumodeIndex}⟩ <span className="text-xs text-slate-500">(wire {wireIndex})</span>
        </h4>
        <div className="flex gap-1">
          {(['fock', 'wigner', 'xdist', 'pdist'] as DisplayMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                mode === m ? 'bg-emerald-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              {m === 'fock' ? 'Fock' : m === 'wigner' ? 'Wigner' : m === 'xdist' ? 'x̂' : 'p̂'}
            </button>
          ))}
        </div>
      </div>

      <div className="text-xs text-slate-400 mb-2 flex justify-between">
        <span>Fock trunc: {fockTruncation}</span>
        <span className="font-mono">⟨n̂⟩ = {meanPhotonNumber.toFixed(2)}</span>
      </div>

      {/* ── Fock mode ── */}
      {mode === 'fock' && (
        <div className="bg-slate-900 rounded p-2">
          {/* Top 3 Fock states */}
          <div className="text-[9px] text-slate-400 mb-2 font-mono">
            {(() => {
              const indexed = fockProbabilities.slice(0, fockTruncation).map((p, i) => ({ n: i, p }));
              return [...indexed].sort((a, b) => b.p - a.p).slice(0, 3).map(({ n, p }) => (
                <span key={n} className="mr-2">|{n}⟩: {(p * 100).toFixed(1)}%</span>
              ));
            })()}
          </div>
          <div className="h-24 flex border-b border-l border-slate-600 relative ml-6">
            <div className="absolute -left-6 top-0 h-full flex flex-col justify-between text-[8px] text-slate-500 w-5 text-right pr-1">
              <span>{(fockMaxProb * 100).toFixed(0)}%</span>
              <span>0</span>
            </div>
            {fockProbabilities.slice(0, effectiveFockShow).map((prob, n) => (
              <div
                key={n}
                className="flex-1 flex flex-col justify-end h-full min-w-0"
                title={`|${n}⟩: ${(prob * 100).toFixed(2)}%`}
              >
                <div
                  className="w-full rounded-t-sm"
                  style={{
                    height: `${Math.max(fockMaxProb > 0 ? (prob / fockMaxProb) * 100 : 0, prob > 0.001 ? 1 : 0)}%`,
                    backgroundColor: prob > 0.01 ? '#10b981' : prob > 0.001 ? '#10b98180' : '#10b98130',
                  }}
                />
              </div>
            ))}
          </div>
          <div className="flex ml-6 mt-1">
            {fockProbabilities.slice(0, effectiveFockShow).map((_, n) => (
              <div key={n} className="flex-1 text-center text-[8px] text-slate-500 min-w-0 overflow-hidden">
                {n % xLabelStep === 0 ? n : ''}
              </div>
            ))}
          </div>
          <div className="text-[9px] text-slate-500 text-center mt-0.5">n (photon number)</div>
          <div className="flex items-center justify-center gap-2 mt-2">
            <button
              onClick={() => setFockShow(s => Math.max(FOCK_MIN, s - FOCK_STEP))}
              disabled={effectiveFockShow <= FOCK_MIN}
              className="px-1.5 py-0.5 text-[10px] bg-slate-700 hover:bg-slate-600 disabled:opacity-30 rounded text-slate-300"
            >−5</button>
            <span className="text-[9px] text-slate-500">showing {effectiveFockShow} levels</span>
            <button
              onClick={() => setFockShow(s => Math.min(maxFockShow, s + FOCK_STEP))}
              disabled={effectiveFockShow >= maxFockShow}
              className="px-1.5 py-0.5 text-[10px] bg-slate-700 hover:bg-slate-600 disabled:opacity-30 rounded text-slate-300"
            >+5</button>
          </div>
        </div>
      )}

      {/* ── Wigner mode ── */}
      {mode === 'wigner' && (
        <div className="relative bg-slate-900 rounded p-2">
          <canvas ref={canvasRef} width={180} height={180} className="mx-auto rounded block" />
          <div className="flex justify-between text-[9px] text-slate-400 mt-1 px-1">
            <span>−{range}</span><span>x</span><span>+{range}</span>
          </div>
          <div className="absolute left-1 top-2 h-[180px] flex flex-col justify-between text-[9px] text-slate-400">
            <span>+{range}</span><span className="text-[8px]">p</span><span>−{range}</span>
          </div>
          <div className="flex justify-center gap-3 mt-1 text-[9px]">
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 bg-blue-500 rounded-sm inline-block" />
              <span className="text-slate-400">W &gt; 0</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 bg-red-500 rounded-sm inline-block" />
              <span className="text-slate-400">W &lt; 0</span>
            </span>
          </div>
          {zoomControls}
        </div>
      )}

      {/* ── x̂ distribution mode ── */}
      {mode === 'xdist' && (() => {
        const dist = computePositionDistribution(fockAmplitudes, DIST_GRID, range);
        return (
          <div className="bg-slate-900 rounded p-2">
            <div className="text-[9px] text-slate-400 mb-1 text-center">
              P(x) — position quadrature marginal
            </div>
            <QuadraturePlotSVG
              data={dist}
              meanVal={xMean}
              meanLabel="x̂"
              axisLabel="x"
              range={range}
              color="#06b6d4"
            />
            {zoomControls}
          </div>
        );
      })()}

      {/* ── p̂ distribution mode ── */}
      {mode === 'pdist' && (() => {
        const dist = computeMomentumDistribution(fockAmplitudes, DIST_GRID, range);
        return (
          <div className="bg-slate-900 rounded p-2">
            <div className="text-[9px] text-slate-400 mb-1 text-center">
              P(p) — momentum quadrature marginal
            </div>
            <QuadraturePlotSVG
              data={dist}
              meanVal={pMean}
              meanLabel="p̂"
              axisLabel="p"
              range={range}
              color="#a78bfa"
            />
            {zoomControls}
          </div>
        );
      })()}

      {/* ── Always-visible quadrature expectation footer ── */}
      <div className="mt-2 pt-2 border-t border-slate-700 flex justify-around text-[10px] font-mono">
        <span>
          <span className="text-cyan-400">⟨x̂⟩</span>
          <span className="text-slate-300"> = {xMean.toFixed(3)}</span>
        </span>
        <span>
          <span className="text-violet-400">⟨p̂⟩</span>
          <span className="text-slate-300"> = {pMean.toFixed(3)}</span>
        </span>
      </div>
    </div>
  );
}

// ── SVG 1-D quadrature distribution plot ─────────────────────────────────────

interface QuadraturePlotSVGProps {
  data: { q: number; prob: number }[];
  meanVal: number;
  meanLabel: string;
  axisLabel: string;
  range: number;
  color: string;
}

function QuadraturePlotSVG({ data, meanVal, meanLabel, axisLabel, range, color }: QuadraturePlotSVGProps) {
  const W = 188, H = 80;
  const ML = 6, MR = 6, MT = 16, MB = 18;
  const PW = W - ML - MR, PH = H - MT - MB;

  const maxProb = Math.max(...data.map(d => d.prob), 1e-6);

  const toX = (q: number) => ML + ((q + range) / (2 * range)) * PW;
  const toY = (p: number) => MT + PH - (p / maxProb) * PH;

  const curvePts = data.map(d => `${toX(d.q).toFixed(1)},${toY(d.prob).toFixed(1)}`).join(' ');
  const areaBase = MT + PH;
  const areaPts = [
    `${toX(data[0].q).toFixed(1)},${areaBase}`,
    ...data.map(d => `${toX(d.q).toFixed(1)},${toY(d.prob).toFixed(1)}`),
    `${toX(data[data.length - 1].q).toFixed(1)},${areaBase}`,
  ].join(' ');

  const mx = toX(meanVal);
  const meanInRange = meanVal >= -range && meanVal <= range;

  return (
    <svg width={W} height={H} className="block mx-auto">
      {/* Filled area */}
      <polygon points={areaPts} fill={color} fillOpacity={0.15} />
      {/* Curve */}
      <polyline points={curvePts} fill="none" stroke={color} strokeWidth={1.5} />
      {/* Mean line */}
      {meanInRange && (
        <>
          <line
            x1={mx} y1={MT} x2={mx} y2={MT + PH}
            stroke="#fbbf24" strokeWidth={1} strokeDasharray="3,2"
          />
          <text x={mx} y={MT - 3} fill="#fbbf24" fontSize={8} textAnchor="middle">
            ⟨{meanLabel}⟩={meanVal.toFixed(2)}
          </text>
        </>
      )}
      {/* X axis */}
      <line x1={ML} y1={MT + PH} x2={ML + PW} y2={MT + PH} stroke="#475569" strokeWidth={1} />
      {/* X tick labels */}
      <text x={ML}          y={H - 4} fill="#64748b" fontSize={8} textAnchor="middle">−{range}</text>
      <text x={ML + PW / 2} y={H - 4} fill="#64748b" fontSize={8} textAnchor="middle">0</text>
      <text x={ML + PW}     y={H - 4} fill="#64748b" fontSize={8} textAnchor="middle">+{range}</text>
      {/* Axis label */}
      <text x={ML + PW / 2} y={H - 4 + 8} fill="#475569" fontSize={7} textAnchor="middle">{axisLabel}</text>
    </svg>
  );
}

// ── Helper functions ──────────────────────────────────────────────────────────

function createVacuumProbabilities(fockDim: number): number[] {
  const probs = new Array(fockDim).fill(0);
  probs[0] = 1;
  return probs;
}

function createVacuumAmplitudes(fockDim: number): { re: number; im: number }[] {
  return Array.from({ length: fockDim }, (_, n) => ({ re: n === 0 ? 1 : 0, im: 0 }));
}


/**
 * Harmonic-oscillator basis functions at point x using the g=2 normalised recurrence:
 *   ψ_0(x)   = (2π)^{−1/4} · exp(−x²/4)
 *   ψ_1(x)   = x · ψ_0(x)
 *   ψ_n(x)   = (x/√n) · ψ_{n−1} − √((n−1)/n) · ψ_{n−2}
 * Valid for x̂ = a+a† convention (g=2, vacuum variance = 1).
 */
function computeHOBasis(x: number, fockDim: number): number[] {
  const basis = new Array(fockDim).fill(0);
  basis[0] = Math.pow(2 * Math.PI, -0.25) * Math.exp(-x * x / 4);
  if (fockDim > 1) basis[1] = x * basis[0];
  for (let n = 2; n < fockDim; n++) {
    basis[n] = Math.sqrt(1 / n) * x * basis[n - 1] - Math.sqrt((n - 1) / n) * basis[n - 2];
  }
  return basis;
}

/** P(x) = |⟨x|ψ⟩|² using position-space HO wavefunctions */
function computePositionDistribution(
  amplitudes: { re: number; im: number }[],
  gridSize: number,
  range: number,
): { q: number; prob: number }[] {
  const result: { q: number; prob: number }[] = [];
  const fockDim = amplitudes.length;
  for (let i = 0; i < gridSize; i++) {
    const q = ((i + 0.5) / gridSize - 0.5) * 2 * range;
    const basis = computeHOBasis(q, fockDim);
    let re = 0, im = 0;
    for (let n = 0; n < fockDim; n++) {
      re += amplitudes[n].re * basis[n];
      im += amplitudes[n].im * basis[n];
    }
    result.push({ q, prob: re * re + im * im });
  }
  return result;
}

/**
 * P(p) = |⟨p|ψ⟩|² using φ_n(p) = (−i)^n ψ_n(p).
 * Rotate each amplitude: c_n → c_n · (−i)^n, then evaluate using HO basis at p.
 */
function computeMomentumDistribution(
  amplitudes: { re: number; im: number }[],
  gridSize: number,
  range: number,
): { q: number; prob: number }[] {
  const result: { q: number; prob: number }[] = [];
  const fockDim = amplitudes.length;

  // Pre-rotate amplitudes by (−i)^n: cycle (1, −i, −1, +i)
  const rotated = amplitudes.map(({ re, im }, n) => {
    switch (n % 4) {
      case 0: return { re,  im };        // × 1
      case 1: return { re: im,  im: -re }; // × (−i)
      case 2: return { re: -re, im: -im }; // × (−1)
      case 3: return { re: -im, im: re };  // × (+i)
      default: return { re, im };
    }
  });

  for (let i = 0; i < gridSize; i++) {
    const p = ((i + 0.5) / gridSize - 0.5) * 2 * range;
    const basis = computeHOBasis(p, fockDim);
    let re = 0, im = 0;
    for (let n = 0; n < fockDim; n++) {
      re += rotated[n].re * basis[n];
      im += rotated[n].im * basis[n];
    }
    result.push({ q: p, prob: re * re + im * im });
  }
  return result;
}
