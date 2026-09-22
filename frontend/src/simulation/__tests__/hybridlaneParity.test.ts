// Cross-checks HyQSim's hybrid gate matrices against hybridlane 0.8.0, the
// reference implementation whose conventions the Jaqal importer/exporter uses.
import { describe, it, expect } from 'vitest';
import type { Complex, Matrix } from '../complex';
import {
  jaynesCouplingMatrix,
  antiJaynesCummingsMatrix,
  zConditionalDisplacementMatrix,
  xConditionalDisplacementMatrix,
  yConditionalDisplacementMatrix,
} from '../tensor';
import { HYBRIDLANE_FOCK_DIM as FD, HYBRIDLANE_PARAMS, HYBRIDLANE_REFERENCE } from './hybridlaneReference';
import { expectMatricesClose } from './helpers';

function reference(key: string): Matrix {
  const raw = HYBRIDLANE_REFERENCE[key];
  expect(raw, `missing reference fixture: ${key}`).toBeDefined();
  return raw.map(row => row.map(([re, im]) => ({ re, im })));
}

const polar = (mag: number, angle: number): Complex =>
  ({ re: mag * Math.cos(angle), im: mag * Math.sin(angle) });

// Compare only the low-photon block: the fixture is an exponential of the
// truncated generator, while HyQSim uses the exact (untruncated) matrix
// elements, so the two necessarily diverge near the top of the Fock ladder.
const COMPARE_UP_TO = 4;

describe('hybrid gates match hybridlane 0.8.0', () => {
  const lowBlock = (M: Matrix): Matrix => {
    const keep = (i: number) => i % FD < COMPARE_UP_TO;
    return M.map((row, i) => row.map((v, j) => (keep(i) && keep(j) ? v : { re: 0, im: 0 })));
  };

  HYBRIDLANE_PARAMS.forEach(([a, b], i) => {
    it(`JC(θ=${a}, φ=${b})`, () => {
      expectMatricesClose(lowBlock(jaynesCouplingMatrix(a, b, FD)), lowBlock(reference(`jc_${i}`)), 1e-9);
    });

    it(`AJC(θ=${a}, φ=${b})`, () => {
      expectMatricesClose(lowBlock(antiJaynesCummingsMatrix(a, b, FD)), lowBlock(reference(`ajc_${i}`)), 1e-9);
    });

    it(`zCD(α=${a}e^{i${b}})`, () => {
      expectMatricesClose(lowBlock(zConditionalDisplacementMatrix(polar(a, b), FD)), lowBlock(reference(`zcd_${i}`)), 1e-6);
    });

    it(`xCD(α=${a}e^{i${b}})`, () => {
      expectMatricesClose(lowBlock(xConditionalDisplacementMatrix(polar(a, b), FD)), lowBlock(reference(`xcd_${i}`)), 1e-6);
    });

    it(`yCD(α=${a}e^{i${b}})`, () => {
      expectMatricesClose(lowBlock(yConditionalDisplacementMatrix(polar(a, b), FD)), lowBlock(reference(`ycd_${i}`)), 1e-6);
    });
  });
});
