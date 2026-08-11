/**
 * Reduces a Wigner distribution to a handful of physically meaningful scalars.
 *
 * The raw grid is 80×80 = 6400 floats. Sending that to a language model is both
 * unaffordable and useless — models cannot read a number soup as a phase-space picture.
 * These features are the things a physicist would actually name when describing the plot:
 * how negative it is, where the negativity sits, how many interference fringes there are,
 * whether it is squeezed, and where it is centred.
 *
 * Serialized form is one line of ~40 tokens; see `formatWignerFeatures`.
 */

import type { QumodeState } from '../types/circuit';
import {
  computeWignerFunction,
  computeWignerFromDensityMatrix,
  transpose,
} from './wigner';

export interface WignerFeatures {
  /** ∫|W| dx dp − 1. Zero for Gaussian states; grows with non-classicality. */
  negativityVolume: number;
  minValue: number;
  minAt: [number, number];
  maxValue: number;
  maxAt: [number, number];
  /** Sign alternations along the axis through the origin perpendicular to the lobe axis. */
  fringeCount: number;
  /** Mean spacing between fringe zero-crossings, in g=2 quadrature units. */
  fringeSpacing: number | null;
  symmetry: 'even' | 'odd' | 'x-mirror' | 'p-mirror' | 'radial' | 'none';
  meanX: number;
  meanP: number;
  /** Vacuum = 1.0 in this convention. Below 1 in a quadrature means squeezing. */
  varX: number;
  varP: number;
  /** 10·log10 of the smallest quadrature variance relative to vacuum; null if unsqueezed. */
  squeezingDb: number | null;
  /** Distinct lobes with |W| above half the global peak — 2 is the cat-state signature. */
  lobeCount: number;
}

/**
 * Obtains W[ix][ip] for a qumode, preferring what the backend already computed.
 * Returns null when there is nothing to work from.
 */
export function wignerFromState(
  state: QumodeState,
  gridSize = 80,
  range = 6.0,
): { grid: number[][]; range: number } | null {
  // Python backend ships a precomputed grid, but transposed: W[p_idx][x_idx].
  if (state.wignerData && state.wignerData.length > 0) {
    return { grid: transpose(state.wignerData), range: state.wignerRange ?? range };
  }
  if (state.densityMatrix && state.densityMatrix.length > 0) {
    return { grid: computeWignerFromDensityMatrix(state.densityMatrix, gridSize, range), range };
  }
  if (state.fockAmplitudes && state.fockAmplitudes.length > 0) {
    return { grid: computeWignerFunction(state.fockAmplitudes, gridSize, range), range };
  }
  return null;
}

function coordAt(i: number, size: number, range: number): number {
  return ((i + 0.5) / size - 0.5) * 2 * range;
}

/**
 * Counts sign alternations of W along a line through the origin at angle `theta`,
 * and returns the mean spacing between crossings.
 */
function scanFringes(
  grid: number[][], size: number, range: number, theta: number, noiseFloor: number,
): { count: number; spacing: number | null } {
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const samples = 200;
  const crossings: number[] = [];
  let prevSign = 0;

  for (let k = 0; k < samples; k++) {
    const s = ((k + 0.5) / samples - 0.5) * 2 * range;
    const x = s * cos, p = s * sin;
    const ix = Math.round(((x / (2 * range)) + 0.5) * size - 0.5);
    const ip = Math.round(((p / (2 * range)) + 0.5) * size - 0.5);
    if (ix < 0 || ix >= size || ip < 0 || ip >= size) continue;

    const v = grid[ix][ip];
    if (!isFinite(v) || Math.abs(v) < noiseFloor) continue;
    const sign = v > 0 ? 1 : -1;
    if (prevSign !== 0 && sign !== prevSign) crossings.push(s);
    prevSign = sign;
  }

  if (crossings.length < 2) return { count: crossings.length, spacing: null };
  let total = 0;
  for (let i = 1; i < crossings.length; i++) total += crossings[i] - crossings[i - 1];
  return { count: crossings.length, spacing: total / (crossings.length - 1) };
}

/** Connected components of |W| > threshold, via flood fill on a coarsened grid. */
function countLobes(grid: number[][], size: number, threshold: number): number {
  const step = Math.max(1, Math.floor(size / 40));
  const n = Math.floor(size / step);
  const mask: boolean[][] = [];
  for (let i = 0; i < n; i++) {
    mask[i] = [];
    for (let j = 0; j < n; j++) mask[i][j] = Math.abs(grid[i * step][j * step]) > threshold;
  }

  const seen: boolean[][] = mask.map(row => row.map(() => false));
  let components = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (!mask[i][j] || seen[i][j]) continue;
      components++;
      const stack: [number, number][] = [[i, j]];
      seen[i][j] = true;
      while (stack.length > 0) {
        const [ci, cj] = stack.pop()!;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || ni >= n || nj < 0 || nj >= n) continue;
          if (!mask[ni][nj] || seen[ni][nj]) continue;
          seen[ni][nj] = true;
          stack.push([ni, nj]);
        }
      }
    }
  }
  return components;
}

export function computeWignerFeatures(grid: number[][], range: number): WignerFeatures {
  const size = grid.length;
  const cell = (2 * range / size) ** 2;

  let minValue = Infinity, maxValue = -Infinity;
  let minAt: [number, number] = [0, 0];
  let maxAt: [number, number] = [0, 0];
  let absIntegral = 0, integral = 0;
  let mX = 0, mP = 0, mXX = 0, mPP = 0;

  for (let ix = 0; ix < size; ix++) {
    const x = coordAt(ix, size, range);
    for (let ip = 0; ip < size; ip++) {
      const v = grid[ix][ip];
      if (!isFinite(v)) continue;
      const p = coordAt(ip, size, range);

      if (v < minValue) { minValue = v; minAt = [x, p]; }
      if (v > maxValue) { maxValue = v; maxAt = [x, p]; }

      absIntegral += Math.abs(v) * cell;
      integral += v * cell;
      mX  += x * v * cell;
      mP  += p * v * cell;
      mXX += x * x * v * cell;
      mPP += p * p * v * cell;
    }
  }

  // Renormalise moments against the actual integral — truncation makes it slightly off 1.
  const norm = Math.abs(integral) > 1e-9 ? integral : 1;
  const meanX = mX / norm;
  const meanP = mP / norm;
  const varX = Math.max(mXX / norm - meanX * meanX, 0);
  const varP = Math.max(mPP / norm - meanP * meanP, 0);

  const negativityVolume = Math.max(absIntegral / Math.abs(norm) - 1, 0);
  const peak = Math.max(Math.abs(minValue), Math.abs(maxValue), 1e-12);
  const noiseFloor = peak * 0.02;

  // Fringes run perpendicular to the axis separating the lobes. Scan both principal axes
  // and report whichever shows more structure.
  const alongX = scanFringes(grid, size, range, 0, noiseFloor);
  const alongP = scanFringes(grid, size, range, Math.PI / 2, noiseFloor);
  const fringes = alongX.count >= alongP.count ? alongX : alongP;

  const lobeCount = countLobes(grid, size, peak * 0.5);

  // Symmetry: compare against the four candidate reflections/inversions.
  let evenErr = 0, oddErr = 0, xMirrorErr = 0, pMirrorErr = 0, total = 0;
  for (let ix = 0; ix < size; ix++) {
    for (let ip = 0; ip < size; ip++) {
      const v = grid[ix][ip];
      if (!isFinite(v)) continue;
      const inv = grid[size - 1 - ix][size - 1 - ip];
      const mirX = grid[size - 1 - ix][ip];   // x → −x
      const mirP = grid[ix][size - 1 - ip];   // p → −p
      evenErr    += Math.abs(v - inv);
      oddErr     += Math.abs(v + inv);
      xMirrorErr += Math.abs(v - mirX);
      pMirrorErr += Math.abs(v - mirP);
      total      += Math.abs(v);
    }
  }
  const tol = Math.max(total * 0.05, 1e-9);
  let symmetry: WignerFeatures['symmetry'] = 'none';
  if (xMirrorErr < tol && pMirrorErr < tol) symmetry = 'radial';
  else if (evenErr < tol) symmetry = 'even';
  else if (oddErr < tol) symmetry = 'odd';
  else if (xMirrorErr < tol) symmetry = 'x-mirror';
  else if (pMirrorErr < tol) symmetry = 'p-mirror';

  // Vacuum variance is 1 in the g=2 convention.
  const minVar = Math.min(varX, varP);
  const squeezingDb = minVar < 0.95 && minVar > 0 ? 10 * Math.log10(minVar) : null;

  return {
    negativityVolume,
    minValue, minAt,
    maxValue, maxAt,
    fringeCount: fringes.count,
    fringeSpacing: fringes.spacing,
    symmetry,
    meanX, meanP,
    varX, varP,
    squeezingDb,
    lobeCount,
  };
}

const n2 = (v: number) => (Math.abs(v) < 5e-3 ? '0' : v.toFixed(2));

/**
 * One-line serialization for the model. Fields that carry no information for the state at
 * hand are dropped rather than sent as zeros — a Gaussian state should not spend tokens
 * saying it has no fringes.
 */
export function formatWignerFeatures(f: WignerFeatures): string {
  const parts: string[] = [];

  if (f.negativityVolume > 0.005) {
    parts.push(`neg=${f.negativityVolume.toFixed(3)}`);
    parts.push(`min=${f.minValue.toFixed(3)}@(${n2(f.minAt[0])},${n2(f.minAt[1])})`);
  } else {
    parts.push('neg=0 (classical/Gaussian)');
  }

  parts.push(`peak@(${n2(f.maxAt[0])},${n2(f.maxAt[1])})`);
  if (f.lobeCount > 1) parts.push(`lobes=${f.lobeCount}`);
  if (f.fringeCount > 1) {
    parts.push(`fringes=${f.fringeCount}${f.fringeSpacing ? `/spacing=${f.fringeSpacing.toFixed(2)}` : ''}`);
  }
  if (f.symmetry !== 'none') parts.push(`sym=${f.symmetry}`);
  parts.push(`<x>=${n2(f.meanX)} <p>=${n2(f.meanP)}`);
  parts.push(`varX=${f.varX.toFixed(2)} varP=${f.varP.toFixed(2)} (vac=1.00)`);
  if (f.squeezingDb !== null) parts.push(`squeezed ${f.squeezingDb.toFixed(1)}dB`);

  return parts.join(' ');
}
