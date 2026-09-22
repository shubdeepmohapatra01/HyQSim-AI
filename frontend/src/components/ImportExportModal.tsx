import { useState, useEffect, useCallback } from 'react';
import type { Wire, CircuitElement } from '../types/circuit';
import { parseBosonicQiskit, generateBosonicQiskit } from '../simulation/qiskitIO';
import { parseHybridLane, generateHybridLane } from '../simulation/hybridlaneIO';
import { parseJaqal, generateJaqal } from '../simulation/jaqalIO';

type CodeFormat = 'bosonic-qiskit' | 'hybridlane' | 'jaqal';

interface ImportExportModalProps {
  mode: 'import' | 'export';
  wires: Wire[];
  elements: CircuitElement[];
  fockTruncation: number;
  onImport: (wires: Wire[], elements: CircuitElement[]) => void;
  onClose: () => void;
}

const FORMAT_LABELS: Record<CodeFormat, string> = {
  'bosonic-qiskit': 'Bosonic Qiskit (c2qa)',
  'hybridlane': 'HybridLane (PennyLane)',
  'jaqal': 'Jaqal (QSCOUT ion trap)',
};

/**
 * One accent colour per format, so the three options read as three separate
 * chips rather than running together into a single line of text. Written out in
 * full because Tailwind scans for complete class names — an interpolated
 * `bg-${colour}-600` would never make it into the stylesheet.
 */
const FORMAT_STYLES: Record<CodeFormat, { selected: string; idle: string }> = {
  'bosonic-qiskit': {
    selected: 'bg-blue-600 border-blue-300 text-white shadow-md shadow-blue-900/50',
    idle: 'bg-slate-950 border-blue-500/70 text-blue-300 hover:bg-blue-600/25 hover:border-blue-400',
  },
  'hybridlane': {
    selected: 'bg-emerald-600 border-emerald-300 text-white shadow-md shadow-emerald-900/50',
    idle: 'bg-slate-950 border-emerald-500/70 text-emerald-300 hover:bg-emerald-600/25 hover:border-emerald-400',
  },
  'jaqal': {
    selected: 'bg-amber-500 border-amber-200 text-slate-950 shadow-md shadow-amber-900/50',
    idle: 'bg-slate-950 border-amber-500/70 text-amber-300 hover:bg-amber-500/25 hover:border-amber-400',
  },
};

const IMPORT_DESCRIPTIONS: Record<CodeFormat, string> = {
  'bosonic-qiskit': 'Paste bosonic qiskit (c2qa) code below. Register declarations are required, but import lines are optional.',
  'hybridlane': 'Paste HybridLane gate calls (qml.* / hqml.*) below. Import lines, decorators, and boilerplate are optional. Loops and conditionals are not supported.',
  'jaqal': 'Paste a Jaqal program from hybridlane\'s QSCOUT device. Qubits come from the register; qumodes are addressed by (manifold, mode) and become qumode wires in order of first appearance. Any gate without an exact HyQSim equivalent stops the import.',
};

const EXPORT_DESCRIPTIONS: Record<CodeFormat, string> = {
  'bosonic-qiskit': 'Generated bosonic qiskit (c2qa) Python code for your circuit.',
  'hybridlane': 'Generated HybridLane (PennyLane) Python code for your circuit.',
  'jaqal': 'Generated Jaqal program for the QSCOUT ion trap. Only gates native to the trap can be exported.',
};

const IMPORT_PLACEHOLDERS: Record<CodeFormat, string> = {
  'bosonic-qiskit': `qmr = c2qa.QumodeRegister(num_qumodes=1, num_qubits_per_qumode=4)\nqbr = qiskit.QuantumRegister(1)\ncircuit = c2qa.CVCircuit(qmr, qbr)\n\ncircuit.h(qbr[0])\ncircuit.cv_d(1.0, qmr[0])\ncircuit.cv_c_d(complex(1, 0.5), qmr[0], qbr[0])`,
  'hybridlane': `qml.Hadamard(wires=0)\nhqml.Displacement(1.0, 0, wires="m0")\nhqml.ConditionalDisplacement(1.0, 0.5, wires=[0, "m0"])`,
  'jaqal': `from Calibration_PulseDefinitions.QubitBosonPulses usepulses *\n\nregister q[3]\n\nsubcircuit {\n    Rz q[2] 4.0297\n    Ry q[2] 2.4589\n    xCD q[2] 1 2 0.98841 0.27302\n    AJC q[1] 1 2 0.0 0.02\n}`,
};

export default function ImportExportModal({
  mode: initialMode,
  wires,
  elements,
  fockTruncation,
  onImport,
  onClose,
}: ImportExportModalProps) {
  const [activeTab, setActiveTab] = useState<'import' | 'export'>(initialMode);
  const [format, setFormat] = useState<CodeFormat>('bosonic-qiskit');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [exportedCode, setExportedCode] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ wires: Wire[]; elements: CircuitElement[] } | null>(null);
  const [copied, setCopied] = useState(false);

  const handleExport = useCallback(() => {
    setError(null);
    try {
      const result = format === 'bosonic-qiskit'
        ? generateBosonicQiskit(wires, elements, fockTruncation)
        : format === 'jaqal'
          ? generateJaqal(wires, elements)
          : generateHybridLane(wires, elements, fockTruncation);
      if (result.success) {
        setExportedCode(result.code);
      } else {
        setError(result.error || 'Export failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    }
  }, [wires, elements, fockTruncation, format]);

  // Auto-export when switching to export tab or changing format
  useEffect(() => {
    if (activeTab === 'export') {
      handleExport();
    }
  }, [activeTab, format, handleExport]);

  const handleImport = () => {
    if (!code.trim()) {
      setError(`Please paste some ${FORMAT_LABELS[format]} code.`);
      return;
    }
    setError(null);
    setWarnings([]);
    setImportResult(null);
    try {
      const result = format === 'bosonic-qiskit'
        ? parseBosonicQiskit(code)
        : format === 'jaqal'
          ? parseJaqal(code)
          : parseHybridLane(code);
      if (result.success) {
        setImportResult({ wires: result.wires, elements: result.elements });
        setWarnings(result.warnings || []);
      } else {
        setError(result.error || 'Import failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    }
  };

  const handleLoadCircuit = () => {
    if (importResult) {
      onImport(importResult.wires, importResult.elements);
      onClose();
    }
  };

  const handleCopy = async () => {
    if (!exportedCode) return;
    try {
      await navigator.clipboard.writeText(exportedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.querySelector('#export-code') as HTMLTextAreaElement;
      if (textarea) {
        textarea.select();
      }
    }
  };

  const handleTabSwitch = (tab: 'import' | 'export') => {
    setActiveTab(tab);
    setError(null);
    setWarnings([]);
    setExportedCode(null);
    if (tab === 'import') {
      setImportResult(null);
    }
  };

  const handleFormatSwitch = (newFormat: CodeFormat) => {
    setFormat(newFormat);
    setError(null);
    setWarnings([]);
    setExportedCode(null);
    setImportResult(null);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-slate-800 rounded-xl w-[640px] max-h-[80vh] flex flex-col border border-slate-600 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with tabs */}
        <div className="flex items-center justify-between border-b border-slate-700 px-4 pt-4 pb-0">
          <div className="flex gap-3">
            <button
              onClick={() => handleTabSwitch('import')}
              aria-pressed={activeTab === 'import'}
              className={`px-5 py-2 text-sm font-semibold rounded-t-lg transition-colors border-b-4 ${
                activeTab === 'import'
                  ? 'bg-slate-900 text-white border-blue-400'
                  : 'text-slate-400 border-transparent hover:text-white hover:bg-slate-700/50'
              }`}
            >
              Import
            </button>
            <button
              onClick={() => handleTabSwitch('export')}
              aria-pressed={activeTab === 'export'}
              className={`px-5 py-2 text-sm font-semibold rounded-t-lg transition-colors border-b-4 ${
                activeTab === 'export'
                  ? 'bg-slate-900 text-white border-purple-400'
                  : 'text-slate-400 border-transparent hover:text-white hover:bg-slate-700/50'
              }`}
            >
              Export
            </button>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white text-xl leading-none pb-2"
          >
            &times;
          </button>
        </div>

        {/* Format selector — shared by the Import and Export tabs */}
        <div className="px-4 pt-3 pb-2 flex items-center gap-3 flex-wrap">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Format
          </span>
          <div className="inline-flex items-stretch gap-2">
            {(['bosonic-qiskit', 'hybridlane', 'jaqal'] as CodeFormat[]).map((f) => (
              <button
                key={f}
                onClick={() => handleFormatSwitch(f)}
                aria-pressed={format === f}
                className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg border-2 transition-colors whitespace-nowrap ${
                  format === f ? FORMAT_STYLES[f].selected : FORMAT_STYLES[f].idle
                }`}
              >
                {FORMAT_LABELS[f]}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {activeTab === 'import' ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-slate-400">
                {IMPORT_DESCRIPTIONS[format]}
              </p>
              <textarea
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setError(null);
                  setImportResult(null);
                }}
                placeholder={IMPORT_PLACEHOLDERS[format]}
                className="w-full h-[300px] bg-slate-950 text-green-400 font-mono text-sm p-3 rounded-lg border border-slate-700 focus:border-blue-500 focus:outline-none resize-none"
                spellCheck={false}
              />

              {error && (
                <div className="p-3 bg-red-900/30 border border-red-700 rounded-lg text-sm text-red-300">
                  {error}
                </div>
              )}

              {importResult && (
                <div className="p-3 bg-green-900/30 border border-green-700 rounded-lg text-sm text-green-300">
                  <p className="font-medium">
                    Parsed successfully: {importResult.wires.length} wire{importResult.wires.length !== 1 ? 's' : ''}, {importResult.elements.length} gate{importResult.elements.length !== 1 ? 's' : ''}
                  </p>
                  <p className="text-xs mt-1 text-green-400">
                    {importResult.wires.filter(w => w.type === 'qubit').length} qubit(s), {importResult.wires.filter(w => w.type === 'qumode').length} qumode(s)
                  </p>
                </div>
              )}

              {warnings.length > 0 && (
                <div className="p-3 bg-yellow-900/30 border border-yellow-700 rounded-lg text-sm text-yellow-300">
                  <p className="font-medium mb-1">Warnings:</p>
                  <ul className="list-disc list-inside text-xs space-y-0.5">
                    {warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}

              <div className="flex gap-2 justify-end">
                {importResult && (
                  <button
                    onClick={handleLoadCircuit}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors"
                  >
                    Load Circuit
                  </button>
                )}
                <button
                  onClick={handleImport}
                  disabled={!code.trim()}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
                >
                  Parse Code
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-slate-400">
                {EXPORT_DESCRIPTIONS[format]}
              </p>

              {error && (
                <div className="p-3 bg-red-900/30 border border-red-700 rounded-lg text-sm text-red-300">
                  {error}
                </div>
              )}

              {exportedCode && (
                <>
                  <textarea
                    id="export-code"
                    value={exportedCode}
                    readOnly
                    className="w-full h-[300px] bg-slate-950 text-green-400 font-mono text-sm p-3 rounded-lg border border-slate-700 resize-none"
                    spellCheck={false}
                  />
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={handleExport}
                      className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm transition-colors"
                    >
                      Regenerate
                    </button>
                    <button
                      onClick={handleCopy}
                      className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm font-medium transition-colors"
                    >
                      {copied ? 'Copied!' : 'Copy to Clipboard'}
                    </button>
                  </div>
                </>
              )}

              {!exportedCode && !error && (
                <p className="text-center text-slate-500 py-8">
                  No circuit to export. Add some gates first.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
