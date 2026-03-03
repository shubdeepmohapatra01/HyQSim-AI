import { useState, useEffect } from 'react';
import type { Gate, CircuitElement, Wire } from '../types/circuit';
import { parseGeneratorExpression, buildGeneratorMatrix } from '../simulation/customGenerator';

// ---------------------------------------------------------------------------
// Math expression parser
// Supports: numbers, pi, e, sqrt(), sin(), cos(), tan(), abs(), +, -, *, /
// ---------------------------------------------------------------------------
function parseExpression(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  let pos = 0;

  function skipSpaces() {
    while (pos < s.length && s[pos] === ' ') pos++;
  }
  function isAlpha(c: string) {
    return /[a-zA-Z_]/.test(c);
  }
  function parseNum(): number {
    let numStr = '';
    while (pos < s.length && (s[pos] >= '0' && s[pos] <= '9' || s[pos] === '.')) {
      numStr += s[pos++];
    }
    if (!numStr) throw new Error('Expected number');
    return parseFloat(numStr);
  }
  function parsePrimary(): number {
    skipSpaces();
    if (pos >= s.length) throw new Error('Unexpected end');

    if (s[pos] === '-') { pos++; return -parsePrimary(); }
    if (s[pos] === '+') { pos++; return parsePrimary(); }

    if (s[pos] === '(') {
      pos++;
      const val = parseAddSub();
      skipSpaces();
      if (pos < s.length && s[pos] === ')') pos++;
      return val;
    }

    const rest = s.slice(pos).toLowerCase();

    // Named constants
    if (rest.startsWith('pi') && (rest.length === 2 || !isAlpha(rest[2]))) {
      pos += 2; return Math.PI;
    }
    // Math functions — must check before 'e' constant
    const funcs: Array<[string, (x: number) => number]> = [
      ['sqrt(', Math.sqrt],
      ['sin(',  Math.sin],
      ['cos(',  Math.cos],
      ['tan(',  Math.tan],
      ['abs(',  Math.abs],
    ];
    for (const [name, fn] of funcs) {
      if (rest.startsWith(name)) {
        pos += name.length;
        const arg = parseAddSub();
        skipSpaces();
        if (pos < s.length && s[pos] === ')') pos++;
        return fn(arg);
      }
    }
    // Euler's number — only if not followed by a letter (to avoid "exp" etc.)
    if (rest.startsWith('e') && (rest.length === 1 || !isAlpha(rest[1]))) {
      pos++; return Math.E;
    }

    return parseNum();
  }
  function parseMulDiv(): number {
    let left = parsePrimary();
    while (true) {
      skipSpaces();
      if (pos >= s.length || (s[pos] !== '*' && s[pos] !== '/')) break;
      const op = s[pos++];
      const right = parsePrimary();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }
  function parseAddSub(): number {
    let left = parseMulDiv();
    while (true) {
      skipSpaces();
      if (pos >= s.length || (s[pos] !== '+' && s[pos] !== '-')) break;
      const op = s[pos++];
      const right = parseMulDiv();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  try {
    const result = parseAddSub();
    skipSpaces();
    if (pos !== s.length) return null; // Unparsed characters remain
    return isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

// Format a numeric value as a clean string for initial display in the text input
function formatNumericValue(val: number): string {
  return String(parseFloat(val.toPrecision(8)));
}

// ---------------------------------------------------------------------------

interface GateParameterEditorProps {
  element: CircuitElement;
  gate: Gate;
  onUpdateParameters: (elementId: string, params: Record<string, number>) => void;
  onUpdateGeneratorExpression?: (elementId: string, expression: string) => void;
  onUpdateTargetWire?: (elementId: string, targetWireIndex: number) => void;
  onSaveCustomGate?: (name: string, expression: string) => void;
  wires?: Wire[];
  onClose: () => void;
}

export default function GateParameterEditor({
  element,
  gate,
  onUpdateParameters,
  onUpdateGeneratorExpression,
  onUpdateTargetWire,
  onSaveCustomGate,
  wires,
  onClose,
}: GateParameterEditorProps) {
  const isCustomGate = gate.category === 'custom';
  const currentParams = element.parameterValues ?? {};

  // Raw text state for each parameter input (separate from the actual numeric value)
  const [rawInputs, setRawInputs] = useState<Record<string, string>>(() => {
    const inputs: Record<string, string> = {};
    for (const param of gate.parameters ?? []) {
      const val = currentParams[param.name] ?? param.defaultValue;
      inputs[param.name] = formatNumericValue(val);
    }
    return inputs;
  });

  // State for custom generator expression
  const [expression, setExpression] = useState(element.generatorExpression || '');
  const [saveName, setSaveName] = useState('');
  const [validationResult, setValidationResult] = useState<{
    isValid: boolean;
    type?: 'cv' | 'dv' | 'hybrid';
    isHermitian?: boolean;
    error?: string;
  }>({ isValid: false });

  // Validate expression when it changes
  useEffect(() => {
    if (!isCustomGate || !expression.trim()) {
      setValidationResult({ isValid: false });
      return;
    }
    try {
      const parsed = parseGeneratorExpression(expression);
      if (!parsed.isValid) {
        setValidationResult({ isValid: false, error: parsed.error });
        return;
      }
      const { type, isHermitian } = buildGeneratorMatrix(expression, 4);
      setValidationResult({
        isValid: true,
        type,
        isHermitian,
        error: isHermitian ? undefined : 'Generator is not Hermitian',
      });
    } catch (err) {
      setValidationResult({
        isValid: false,
        error: err instanceof Error ? err.message : 'Validation error',
      });
    }
  }, [expression, isCustomGate]);

  // Save expression when it changes and is valid
  useEffect(() => {
    if (isCustomGate && onUpdateGeneratorExpression && validationResult.isValid && validationResult.isHermitian) {
      onUpdateGeneratorExpression(element.id, expression);
    }
  }, [expression, validationResult, isCustomGate, onUpdateGeneratorExpression, element.id]);

  const handleParamChange = (paramName: string, value: number) => {
    const newParams = { ...currentParams, [paramName]: value };
    onUpdateParameters(element.id, newParams);
  };

  const handleRawInputChange = (paramName: string, rawValue: string) => {
    setRawInputs(prev => ({ ...prev, [paramName]: rawValue }));
    const parsed = parseExpression(rawValue);
    if (parsed !== null) {
      handleParamChange(paramName, parsed);
    }
  };

  const getCategoryColor = () => {
    switch (gate.category) {
      case 'qubit':   return 'border-blue-500 bg-blue-900/50';
      case 'qumode':  return 'border-emerald-500 bg-emerald-900/50';
      case 'hybrid':  return 'border-purple-500 bg-purple-900/50';
      case 'custom':  return 'border-amber-500 bg-amber-900/50';
      default:        return 'border-slate-500 bg-slate-900/50';
    }
  };

  const getTypeLabel = (type: 'cv' | 'dv' | 'hybrid') => {
    switch (type) {
      case 'cv':     return { label: 'Continuous Variable (Qumode)', color: 'text-emerald-400' };
      case 'dv':     return { label: 'Discrete Variable (Qubit)',    color: 'text-blue-400' };
      case 'hybrid': return { label: 'Hybrid (Qubit + Qumode)',       color: 'text-purple-400' };
    }
  };

  const currentWire = wires?.[element.wireIndex];
  const availableTargetWires = wires?.filter((w, idx) => {
    if (idx === element.wireIndex) return false;
    if (validationResult.type === 'hybrid') return w.type !== currentWire?.type;
    return false;
  }) ?? [];

  if (!gate.parameters?.length && !isCustomGate) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className={`rounded-lg p-4 border-2 ${getCategoryColor()} min-w-[350px] max-w-[450px]`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold text-white">
            {gate.name} ({gate.symbol})
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl">
            ×
          </button>
        </div>

        <p className="text-sm text-slate-300 mb-4">{gate.description}</p>

        {/* Custom Generator Expression Input */}
        {isCustomGate && (
          <div className="mb-4 space-y-3">
            <div>
              <label className="block text-sm text-slate-300 mb-1">
                Generator Expression (G)
              </label>
              <input
                type="text"
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                placeholder="e.g., a + ad, z * n, x + y"
                className={`w-full px-3 py-2 bg-slate-800 border rounded text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 ${
                  expression && !validationResult.isValid
                    ? 'border-red-500 focus:ring-red-500'
                    : validationResult.isValid && validationResult.isHermitian
                    ? 'border-green-500 focus:ring-green-500'
                    : 'border-slate-600 focus:ring-amber-500'
                }`}
              />
              <div className="mt-1 text-xs text-slate-500">
                CV: a, ad, n | DV: x, y, z | Ops: +, -, *, i
              </div>
            </div>

            {expression && (
              <div className="p-2 rounded bg-slate-800/50">
                {validationResult.isValid ? (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400">Type:</span>
                      <span className={`text-xs font-medium ${getTypeLabel(validationResult.type!).color}`}>
                        {getTypeLabel(validationResult.type!).label}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-slate-400">Hermitian:</span>
                      {validationResult.isHermitian ? (
                        <span className="text-xs text-green-400">Yes (valid generator)</span>
                      ) : (
                        <span className="text-xs text-red-400">No (invalid — must be Hermitian)</span>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-red-400">
                    {validationResult.error || 'Invalid expression'}
                  </div>
                )}
              </div>
            )}

            {validationResult.type === 'hybrid' && validationResult.isHermitian && onUpdateTargetWire && (
              <div>
                <label className="block text-sm text-slate-300 mb-1">
                  Target Wire ({currentWire?.type === 'qubit' ? 'Qumode' : 'Qubit'})
                </label>
                <select
                  value={element.targetWireIndices?.[0] ?? ''}
                  onChange={(e) => {
                    const idx = parseInt(e.target.value, 10);
                    if (!isNaN(idx)) onUpdateTargetWire(element.id, idx);
                  }}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  <option value="">Select target wire...</option>
                  {availableTargetWires.map((w) => {
                    const idx = wires!.indexOf(w);
                    return (
                      <option key={w.id} value={idx}>
                        {w.type === 'qubit' ? `q${w.index}` : `m${w.index}`}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}

            {validationResult.isValid && validationResult.isHermitian && onSaveCustomGate && (
              <div className="pt-2 border-t border-slate-700">
                <label className="block text-sm text-slate-300 mb-1">Save to Palette</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    placeholder="Gate name (e.g., Dx, Dp)"
                    className="flex-1 px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (saveName.trim() && expression.trim()) {
                        onSaveCustomGate(saveName.trim(), expression.trim());
                        setSaveName('');
                      }
                    }}
                    disabled={!saveName.trim()}
                    className={`px-3 py-2 rounded text-sm font-medium ${
                      saveName.trim() ? 'bg-amber-600 hover:bg-amber-700' : 'bg-slate-600 cursor-not-allowed'
                    }`}
                  >
                    Save
                  </button>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Saves this generator to the palette for quick reuse
                </div>
              </div>
            )}
          </div>
        )}

        {/* Parameter inputs */}
        {gate.parameters && gate.parameters.length > 0 && (
          <div className="space-y-4">
            {gate.parameters.map((param) => {
              const raw = rawInputs[param.name] ?? '';
              const parsed = parseExpression(raw);
              const isValid = parsed !== null;
              const isAngle = param.unit === 'rad';

              return (
                <div key={param.name} className="space-y-1">
                  <label className="block text-sm text-slate-300">
                    {param.symbol}
                    {param.unit && <span className="text-slate-500 ml-1">({param.unit})</span>}
                  </label>
                  <input
                    type="text"
                    value={raw}
                    onChange={(e) => handleRawInputChange(param.name, e.target.value)}
                    placeholder={isAngle ? 'e.g. pi/4, pi/2, pi' : 'e.g. 1, -0.5, sqrt(2)'}
                    className={`w-full px-3 py-2 bg-slate-800 border rounded text-white font-mono placeholder:text-slate-600 focus:outline-none focus:ring-2 ${
                      raw && !isValid
                        ? 'border-red-500 focus:ring-red-500'
                        : isValid
                        ? 'border-slate-600 focus:ring-blue-500'
                        : 'border-slate-600 focus:ring-blue-500'
                    }`}
                  />
                  <div className="text-xs">
                    {raw && !isValid ? (
                      <span className="text-red-400">Invalid expression</span>
                    ) : isValid && parsed !== null ? (
                      <span className="text-slate-400">
                        = {parseFloat(parsed.toFixed(6))}
                        {isAngle && (
                          <span className="ml-2 text-slate-500">
                            ≈ {(parsed / Math.PI).toFixed(4)}π
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-slate-600">
                        {isAngle ? 'Type a value or expression like pi/4' : 'Type any number or expression'}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <button
            onClick={() => {
              const defaults: Record<string, number> = {};
              const newRawInputs: Record<string, string> = {};
              if (gate.parameters) {
                for (const p of gate.parameters) {
                  defaults[p.name] = p.defaultValue;
                  newRawInputs[p.name] = formatNumericValue(p.defaultValue);
                }
              }
              onUpdateParameters(element.id, defaults);
              setRawInputs(newRawInputs);
              if (isCustomGate) setExpression('');
            }}
            className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm"
          >
            Reset
          </button>
          <button
            onClick={onClose}
            className={`flex-1 py-2 rounded text-sm font-medium ${
              isCustomGate && (!validationResult.isValid || !validationResult.isHermitian)
                ? 'bg-slate-600 cursor-not-allowed'
                : 'bg-amber-600 hover:bg-amber-700'
            }`}
            disabled={isCustomGate && (!validationResult.isValid || !validationResult.isHermitian)}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
