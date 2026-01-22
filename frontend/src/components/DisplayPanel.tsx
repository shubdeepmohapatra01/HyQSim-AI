import type { Wire, SimulationResult, QubitPostSelection } from '../types/circuit';
import QubitDisplay from './QubitDisplay';
import QumodeDisplay from './QumodeDisplay';

type SimulationBackend = 'browser' | 'python';

interface DisplayPanelProps {
  wires: Wire[];
  fockTruncation: number;
  onFockTruncationChange: (value: number) => void;
  simulationResult: SimulationResult | null;
  onRunSimulation: () => void;
  isSimulating: boolean;
  backend: SimulationBackend;
  postSelections: QubitPostSelection[];
  onPostSelectionsChange: (selections: QubitPostSelection[]) => void;
}

export default function DisplayPanel({
  wires,
  fockTruncation,
  onFockTruncationChange,
  simulationResult,
  onRunSimulation,
  isSimulating,
  backend,
  postSelections,
  onPostSelectionsChange,
}: DisplayPanelProps) {
  const qubits = wires
    .map((w, idx) => ({ wire: w, wireIndex: idx }))
    .filter(({ wire }) => wire.type === 'qubit');
  const qumodes = wires
    .map((w, idx) => ({ wire: w, wireIndex: idx }))
    .filter(({ wire }) => wire.type === 'qumode');

  // Helper to get post-selection for a qubit wire
  const getPostSelection = (wireIndex: number): 0 | 1 | 'none' => {
    const ps = postSelections.find(p => p.wireIndex === wireIndex);
    return ps ? ps.outcome : 'none';
  };

  // Helper to set post-selection for a qubit wire
  const setPostSelection = (wireIndex: number, value: 0 | 1 | 'none') => {
    if (value === 'none') {
      onPostSelectionsChange(postSelections.filter(p => p.wireIndex !== wireIndex));
    } else {
      const existing = postSelections.find(p => p.wireIndex === wireIndex);
      if (existing) {
        onPostSelectionsChange(
          postSelections.map(p => p.wireIndex === wireIndex ? { ...p, outcome: value } : p)
        );
      } else {
        onPostSelectionsChange([...postSelections, { wireIndex, outcome: value }]);
      }
    }
  };

  return (
    <div className="bg-slate-800 p-4 rounded-xl h-full overflow-y-auto">
      <h2 className="text-lg font-bold mb-4 text-white">State Display</h2>

      {/* Fock truncation control */}
      <div className="mb-4 p-3 bg-slate-700 rounded-lg">
        <label className="block text-sm text-slate-300 mb-2">
          Fock Truncation{backend === 'python' ? ' (must be 2^n)' : ''}
        </label>
        {backend === 'python' ? (
          <div className="flex items-center gap-2">
            {[4, 8, 16, 32].map((val) => (
              <button
                key={val}
                onClick={() => onFockTruncationChange(val)}
                className={`px-3 py-1.5 rounded text-sm font-mono transition-colors ${
                  fockTruncation === val
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-600 text-slate-300 hover:bg-slate-500'
                }`}
              >
                {val}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="range"
              min="4"
              max="32"
              value={fockTruncation}
              onChange={(e) => onFockTruncationChange(parseInt(e.target.value))}
              className="flex-1 h-2 bg-slate-600 rounded-lg appearance-none cursor-pointer accent-emerald-500"
            />
            <span className="w-8 text-center font-mono text-sm">{fockTruncation}</span>
          </div>
        )}
        <p className="text-[10px] text-slate-500 mt-1">
          Higher values = more precision, slower simulation
        </p>
      </div>

      {/* Post-selection controls (only show if there are qubits) */}
      {qubits.length > 0 && (
        <div className="mb-4 p-3 bg-slate-700 rounded-lg">
          <label className="block text-sm text-slate-300 mb-2">
            Qubit Post-Selection
          </label>
          <p className="text-[10px] text-slate-500 mb-2">
            Project onto measurement outcome for pure states
          </p>
          <div className="space-y-2">
            {qubits.map(({ wire, wireIndex }) => (
              <div key={wire.id} className="flex items-center gap-2">
                <span className="text-xs text-blue-400 w-12">q{wire.index}:</span>
                <div className="flex bg-slate-600 rounded p-0.5">
                  <button
                    onClick={() => setPostSelection(wireIndex, 'none')}
                    className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                      getPostSelection(wireIndex) === 'none'
                        ? 'bg-slate-500 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Mixed
                  </button>
                  <button
                    onClick={() => setPostSelection(wireIndex, 0)}
                    className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                      getPostSelection(wireIndex) === 0
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    |0⟩
                  </button>
                  <button
                    onClick={() => setPostSelection(wireIndex, 1)}
                    className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                      getPostSelection(wireIndex) === 1
                        ? 'bg-purple-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    |1⟩
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Simulate button */}
      <div className="mb-4">
        <button
          onClick={onRunSimulation}
          disabled={wires.length === 0 || isSimulating}
          className="w-full py-3 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700
            rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed
            flex items-center justify-center gap-2"
        >
          {isSimulating ? (
            <>
              <span className="animate-spin">⟳</span>
              Simulating...
            </>
          ) : (
            'Run Simulation'
          )}
        </button>
        {simulationResult && (
          <div className="mt-2 p-2 bg-slate-700/50 rounded-lg">
            <div className="flex items-center justify-center gap-2">
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                  simulationResult.backend === 'bosonic-qiskit'
                    ? 'bg-purple-600/80 text-purple-100'
                    : 'bg-blue-600/80 text-blue-100'
                }`}
              >
                {simulationResult.backend === 'bosonic-qiskit' ? 'Python' : 'Browser'}
              </span>
              <span className="text-[10px] text-slate-400">
                {simulationResult.executionTime < 1
                  ? `${simulationResult.executionTime.toFixed(2)}ms`
                  : `${(simulationResult.executionTime / 1000).toFixed(2)}s`}
              </span>
            </div>
            <p className="text-[10px] text-emerald-400 text-center mt-1">
              Simulation complete
            </p>
          </div>
        )}
      </div>

      {wires.length === 0 ? (
        <div className="text-slate-500 text-center py-8">
          <p>No qubits or qumodes in circuit</p>
          <p className="text-sm mt-1">Add wires to see state visualization</p>
        </div>
      ) : (
        <>
          {/* Qubit displays */}
          {qubits.length > 0 && (
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-blue-400 mb-2 border-b border-blue-500/30 pb-1">
                Qubits ({qubits.length})
              </h3>
              <div className="space-y-2">
                {qubits.map(({ wire, wireIndex }) => (
                  <QubitDisplay
                    key={wire.id}
                    qubitIndex={wire.index}
                    wireIndex={wireIndex}
                    state={simulationResult?.qubitStates.get(wireIndex)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Qumode displays */}
          {qumodes.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-emerald-400 mb-2 border-b border-emerald-500/30 pb-1">
                Qumodes ({qumodes.length})
              </h3>
              <div className="space-y-2">
                {qumodes.map(({ wire, wireIndex }) => (
                  <QumodeDisplay
                    key={wire.id}
                    qumodeIndex={wire.index}
                    wireIndex={wireIndex}
                    fockTruncation={fockTruncation}
                    state={simulationResult?.qumodeStates.get(wireIndex)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
