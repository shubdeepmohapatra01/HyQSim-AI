import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import GatePalette from './components/GatePalette';
import CircuitCanvas from './components/CircuitCanvas';
import DisplayPanel from './components/DisplayPanel';
import GateParameterEditor from './components/GateParameterEditor';
import ImportExportModal from './components/ImportExportModal';
import BenchmarkMenu from './components/BenchmarkMenu';
import ChatPanel from './components/ChatPanel';
import McpSessionBadge from './components/McpSessionBadge';
import { CanvasSession, type SessionStatus } from './mcp/session';
// import RabiPlot from './components/RabiPlot';
import { BENCHMARKS, recomputeCatCDParams } from './benchmarks/circuits';
// import { runJCSweep } from './benchmarks/sweep';
// import type { JCSweepPoint } from './benchmarks/sweep';
import type { Gate, Wire, CircuitElement, SimulationResult, QubitPostSelection, QubitInitialState, QumodeInitialState } from './types/circuit';
import { ALL_GATES, getDefaultParameters } from './types/circuit';
import { runSimulation, getQubitBitstringPositions, marginalizeCountsToPositions } from './simulation/simulator';
import { checkBackendHealth, runBackendSimulation } from './api/backend';

type SimulationBackend = 'browser' | 'python';

function App() {
  const [wires, setWires] = useState<Wire[]>([]);
  const [elements, setElements] = useState<CircuitElement[]>([]);
  const [fockTruncation, setFockTruncation] = useState(8); // Must be power of 2 for Python backend
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);

  // // JC Rabi-plot state
  // const [activeJCParams, setActiveJCParams] = useState<{ nSteps: number; g: number; omega: number; tau: number } | null>(null);
  // const [jcSweepData, setJcSweepData] = useState<JCSweepPoint[] | null>(null);

  // Backend state
  const [backend, setBackend] = useState<SimulationBackend>('browser');
  const [backendAvailable, setBackendAvailable] = useState(false);
  const [backendChecking, setBackendChecking] = useState(true);

  // For gate parameter editing
  const [selectedElement, setSelectedElement] = useState<CircuitElement | null>(null);

  // Saved custom gates (user-defined generators)
  const [savedCustomGates, setSavedCustomGates] = useState<Array<{ name: string; expression: string }>>(
    () => {
      // Load from localStorage if available
      const saved = localStorage.getItem('hyqsim-custom-gates');
      return saved ? JSON.parse(saved) : [];
    }
  );

  // Post-selection for qubits (for cat state visualization)
  const [postSelections, setPostSelections] = useState<QubitPostSelection[]>([]);

  // Number of measurement shots for bitstring histogram
  const [shots, setShots] = useState(1024);
  const [canvasVersion, setCanvasVersion] = useState(0);

  // Import/Export modal
  const [qiskitIOMode, setQiskitIOMode] = useState<'import' | 'export' | null>(null);

  // Check backend health on mount
  useEffect(() => {
    const checkHealth = async () => {
      setBackendChecking(true);
      const health = await checkBackendHealth();
      setBackendAvailable(health.available && health.bosonicAvailable);
      setBackendChecking(false);
    };
    checkHealth();
    // Re-check every 30 seconds
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  // Create a map of gate IDs to gates for quick lookup
  const gatesMap = useMemo(() => new Map(ALL_GATES.map((g) => [g.id, g])), []);

  // Track qubit and qumode counts separately
  const [qubitCount, setQubitCount] = useState(0);
  const [qumodeCount, setQumodeCount] = useState(0);

  const handleAddWire = useCallback((type: 'qubit' | 'qumode') => {
    const newWire: Wire = {
      id: `${type}-${Date.now()}`,
      type,
      index: type === 'qubit' ? qubitCount : qumodeCount,
    };

    if (type === 'qubit') {
      setQubitCount((c) => c + 1);
    } else {
      setQumodeCount((c) => c + 1);
    }

    setWires((prev) => [...prev, newWire]);
    setSimulationResult(null); // Clear simulation when circuit changes
  }, [qubitCount, qumodeCount]);

  const handleRemoveWire = useCallback((wireId: string) => {
    const wireIndex = wires.findIndex((w) => w.id === wireId);
    setWires((prev) => prev.filter((w) => w.id !== wireId));
    setElements((prev) =>
      prev
        // Remove elements on the deleted wire or targeting it
        .filter((e) =>
          e.wireIndex !== wireIndex &&
          !(e.targetWireIndices?.includes(wireIndex))
        )
        // Shift down indices above the removed wire
        .map((e) => ({
          ...e,
          wireIndex: e.wireIndex > wireIndex ? e.wireIndex - 1 : e.wireIndex,
          targetWireIndices: e.targetWireIndices?.map(t =>
            t > wireIndex ? t - 1 : t
          ),
        }))
    );
    setSimulationResult(null);
  }, [wires]);

  const handleWireInitialStateChange = useCallback((wireId: string, newState: QubitInitialState | QumodeInitialState) => {
    setWires((prev) =>
      prev.map((w) =>
        w.id === wireId ? { ...w, initialState: newState } : w
      )
    );
    setSimulationResult(null);
  }, []);

  const handleRemoveElement = useCallback((elementId: string) => {
    setElements((prev) => prev.filter((e) => e.id !== elementId));
    setSimulationResult(null);
  }, []);

  const handleDropGate = useCallback(
    (gate: Gate & { generatorExpression?: string }, wireIndex: number, position: { x: number; y: number }, targetWireIndices?: number[], parameterValues?: Record<string, number>) => {
      const newElement: CircuitElement = {
        // Random suffix matters: batch placement (benchmarks, AI build_circuit) can add
        // several gates inside the same millisecond, and duplicate ids break removal.
        id: `element-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        gateId: gate.id.startsWith('custom-saved-') ? (targetWireIndices?.length ? 'custom_cvdv' : 'custom_cv') : gate.id,
        position,
        wireIndex,
        targetWireIndices,
        parameterValues: parameterValues ?? getDefaultParameters(gate),
        // Preserve generator expression from saved custom gates
        generatorExpression: gate.generatorExpression,
      };

      setElements((prev) => [...prev, newElement]);
      setSimulationResult(null);
    },
    []
  );

  /**
   * Appends a fully-formed element. Used by the AI assistant, which has already validated
   * and positioned the gate via `ai/hqc.placeGate` and needs the element it constructed to
   * land on the canvas unchanged.
   */
  const handleAddElement = useCallback((element: CircuitElement) => {
    setElements((prev) => [...prev, element]);
    setSimulationResult(null);
  }, []);

  const handleDragStart = useCallback(() => {
    // Could track dragged gate if needed
  }, []);

  const handleElementClick = useCallback((element: CircuitElement) => {
    const gate = gatesMap.get(element.gateId);
    // Open editor for gates with parameters OR custom gates (which need expression input)
    if ((gate?.parameters && gate.parameters.length > 0) || gate?.category === 'custom') {
      setSelectedElement(element);
    }
  }, [gatesMap]);

  const handleUpdateParameters = useCallback((elementId: string, params: Record<string, number>) => {
    setElements((prev) => {
      const updated = prev.map((e) =>
        e.id === elementId ? { ...e, parameterValues: params } : e
      );
      // Propagate linked cat state CD parameters
      const changedEl = updated.find((e) => e.id === elementId);
      if (changedEl?.benchmarkGroup === 'cat-cd1' || changedEl?.benchmarkGroup === 'cat-cd2') {
        const { partnerGroup, partnerParams } = recomputeCatCDParams(
          changedEl.benchmarkGroup as 'cat-cd1' | 'cat-cd2',
          params,
        );
        return updated.map((e) =>
          e.benchmarkGroup === partnerGroup ? { ...e, parameterValues: partnerParams } : e
        );
      }
      return updated;
    });
    setSimulationResult(null);
  }, []);

  const handleUpdateGeneratorExpression = useCallback((elementId: string, expression: string) => {
    setElements((prev) =>
      prev.map((e) =>
        e.id === elementId ? { ...e, generatorExpression: expression } : e
      )
    );
    setSimulationResult(null);
  }, []);

  const handleUpdateTargetWire = useCallback((elementId: string, targetWireIndex: number) => {
    setElements((prev) =>
      prev.map((e) =>
        e.id === elementId ? { ...e, targetWireIndices: [targetWireIndex] } : e
      )
    );
    setSimulationResult(null);
  }, []);

  const handleSaveCustomGate = useCallback((name: string, expression: string) => {
    setSavedCustomGates((prev) => {
      // Check if name already exists
      const existing = prev.findIndex((g) => g.name === name);
      let updated;
      if (existing >= 0) {
        // Update existing
        updated = [...prev];
        updated[existing] = { name, expression };
      } else {
        // Add new
        updated = [...prev, { name, expression }];
      }
      // Persist to localStorage
      localStorage.setItem('hyqsim-custom-gates', JSON.stringify(updated));
      return updated;
    });
  }, []);

  const handleRemoveCustomGate = useCallback((name: string) => {
    setSavedCustomGates((prev) => {
      const updated = prev.filter((g) => g.name !== name);
      localStorage.setItem('hyqsim-custom-gates', JSON.stringify(updated));
      return updated;
    });
  }, []);

  /**
   * Runs the simulation and returns the result.
   *
   * `override` exists for the AI assistant: when it builds a circuit and runs it in the
   * same agent turn, React state has not committed yet, so the closure here still sees the
   * previous circuit. The assistant passes the circuit it just built explicitly.
   *
   * Returning the result (rather than only setting state) lets the assistant read the
   * numbers immediately, for the same reason. The Run button ignores the return value.
   */
  const handleRunSimulation = useCallback(async (
    override?: { wires: Wire[]; elements: CircuitElement[] },
  ): Promise<SimulationResult | null> => {
    const runWires = override?.wires ?? wires;
    const runElements = override?.elements ?? elements;

    setIsSimulating(true);

    // Collect wire indices that have a Measure gate placed on them
    const measuredWireIndices = runElements
      .filter(e => e.gateId === 'measure')
      .map(e => e.wireIndex);

    try {
      if (backend === 'python' && backendAvailable) {
        // Strip measure gates — the Python backend doesn't know about them
        const nonMeasureElements = runElements.filter(e => e.gateId !== 'measure');
        const rawResult = await runBackendSimulation(runWires, nonMeasureElements, fockTruncation, postSelections, shots);

        // Marginalize bitstrings to only the measured qubits
        let bitstringCounts = rawResult.bitstringCounts;
        if (measuredWireIndices.length > 0 && bitstringCounts) {
          const positions = getQubitBitstringPositions(runWires, measuredWireIndices);
          bitstringCounts = positions.length > 0
            ? marginalizeCountsToPositions(bitstringCounts, positions)
            : undefined;
        } else {
          bitstringCounts = undefined;
        }

        const finalResult = { ...rawResult, bitstringCounts };
        setSimulationResult(finalResult);
        return finalResult;
      }

      // Use browser-based simulation.
      // setTimeout lets the UI paint before the heavy computation blocks the main thread.
      return await new Promise<SimulationResult | null>((resolve) => {
        setTimeout(() => {
          try {
            const result = runSimulation(runWires, runElements, gatesMap, fockTruncation, postSelections, shots, measuredWireIndices);
            setSimulationResult(result);
            resolve(result);
          } catch (error) {
            console.error('Simulation error:', error);
            alert('Simulation error. Check console for details.');
            resolve(null);
          }
        }, 10);
      });
    } catch (error) {
      console.error('Simulation error:', error);
      alert(`Simulation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    } finally {
      setIsSimulating(false);
    }
  }, [wires, elements, gatesMap, fockTruncation, backend, backendAvailable, postSelections, shots]);

  const handleImportCircuit = useCallback((newWires: Wire[], newElements: CircuitElement[]) => {
    setWires(newWires);
    setElements(newElements);
    setQubitCount(newWires.filter(w => w.type === 'qubit').length);
    setQumodeCount(newWires.filter(w => w.type === 'qumode').length);
    setSimulationResult(null);
    setPostSelections([]);
    // setActiveJCParams(null);
    // setJcSweepData(null);
  }, []);

  const handleClearCanvas = useCallback(() => {
    setWires([]);
    setElements([]);
    setQubitCount(0);
    setQumodeCount(0);
    setSimulationResult(null);
    setPostSelections([]);
    setCanvasVersion(v => v + 1); // signals ChatPanel to reset conversation history
  }, []);

  // ─── MCP bridge ─────────────────────────────────────────────────────────────
  // Lets an external AI client (Claude Desktop / Claude Code) drive this canvas over the
  // user's own subscription rather than an API key. Opt-in, and off by default: opening a
  // socket that lets another process rewrite the canvas should be a deliberate choice.
  //
  // Simulation stays here. When the MCP server asks for results we run HyQSim's simulator
  // locally with the user's selected backend, then send back what it produced.

  const [mcpEnabled, setMcpEnabled] = useState(() => {
    try { return localStorage.getItem('hyqsim-mcp-enabled') === 'true'; } catch { return false; }
  });
  const [mcpStatus, setMcpStatus] = useState<SessionStatus>('disabled');
  const [mcpCode, setMcpCode] = useState<string | null>(null);
  const [mcpError, setMcpError] = useState<string | undefined>();
  const sessionRef = useRef<CanvasSession | null>(null);

  // Latest values for the session callbacks, which outlive any single render.
  const runSimulationRef = useRef(handleRunSimulation);
  useEffect(() => { runSimulationRef.current = handleRunSimulation; }, [handleRunSimulation]);
  const importCircuitRef = useRef(handleImportCircuit);
  useEffect(() => { importCircuitRef.current = handleImportCircuit; }, [handleImportCircuit]);

  useEffect(() => {
    if (!mcpEnabled) {
      sessionRef.current?.disconnect();
      sessionRef.current = null;
      setMcpStatus('disabled');
      setMcpCode(null);
      setMcpError(undefined);
      return;
    }

    const session = new CanvasSession({
      onCircuit: (newWires, newElements) => importCircuitRef.current(newWires, newElements),
      onRunSimulation: () => runSimulationRef.current({
        wires: sessionWiresRef.current,
        elements: sessionElementsRef.current,
      }),
      onStatusChange: (status, code, error) => {
        setMcpStatus(status);
        setMcpCode(code);
        setMcpError(error);
      },
    });
    sessionRef.current = session;
    session.connect();

    return () => {
      session.disconnect();
      sessionRef.current = null;
    };
  }, [mcpEnabled]);

  // The simulation request arrives asynchronously, so the callback above needs the
  // circuit as of right now rather than as of the render that created the session.
  const sessionWiresRef = useRef(wires);
  const sessionElementsRef = useRef(elements);
  useEffect(() => { sessionWiresRef.current = wires; }, [wires]);
  useEffect(() => { sessionElementsRef.current = elements; }, [elements]);

  // Mirror local canvas edits up so an AI client sees what the user is doing.
  useEffect(() => {
    sessionRef.current?.pushCircuit(wires, elements, fockTruncation, backend);
  }, [wires, elements, fockTruncation, backend]);

  // Share results the user produced with the Run button, so the AI need not re-run.
  useEffect(() => {
    if (simulationResult) sessionRef.current?.pushResult(simulationResult);
  }, [simulationResult]);

  const toggleMcp = useCallback((next: boolean) => {
    setMcpEnabled(next);
    try { localStorage.setItem('hyqsim-mcp-enabled', String(next)); } catch { /* ignore */ }
  }, []);

  const handleLoadBenchmark = useCallback((benchmarkId: string, mode: 'new' | 'append' | 'append-new-qubits', params?: Record<string, number>) => {
    const benchmark = BENCHMARKS.find(b => b.id === benchmarkId);
    if (!benchmark) return;
    const { wires: bmWires, elements: bmElements, fockTruncation: newFock } = benchmark.build(params);

    if (mode === 'new' || wires.length === 0) {
      setWires(bmWires);
      setElements(bmElements);
      setFockTruncation(newFock);
      setQubitCount(bmWires.filter(w => w.type === 'qubit').length);
      setQumodeCount(bmWires.filter(w => w.type === 'qumode').length);
      setSimulationResult(null);
      setPostSelections([]);
      // // Track JC params so we can offer the Rabi-plot button
      // if (benchmarkId === 'jc-trotter' && params) {
      //   setActiveJCParams({ nSteps: params.nSteps ?? 16, g: params.g ?? 1.0, omega: params.omega ?? 1.0, tau: params.tau ?? Math.PI / 32 });
      // } else {
      //   setActiveJCParams(null);
      // }
      // setJcSweepData(null);
      return;
    }

    // Append mode: reuse existing wires where possible, only add new ones if needed
    // 'append-new-qubits': reuse qumodes but always create fresh qubits
    const reuseQubits = mode === 'append';

    const existingQumodes = wires.map((w, i) => ({ wire: w, idx: i })).filter(e => e.wire.type === 'qumode');
    const existingQubits = wires.map((w, i) => ({ wire: w, idx: i })).filter(e => e.wire.type === 'qubit');
    const bmQumodes = bmWires.map((w, i) => ({ wire: w, idx: i })).filter(e => e.wire.type === 'qumode');
    const bmQubits = bmWires.map((w, i) => ({ wire: w, idx: i })).filter(e => e.wire.type === 'qubit');

    // Build wire index mapping: benchmark wire index → circuit wire index
    const wireMap = new Map<number, number>();

    // Map benchmark qumodes to existing qumodes, create new ones only if needed
    for (let i = 0; i < bmQumodes.length; i++) {
      if (i < existingQumodes.length) {
        wireMap.set(bmQumodes[i].idx, existingQumodes[i].idx);
      }
    }

    // Map benchmark qubits to existing qubits only in 'append' mode
    if (reuseQubits) {
      for (let i = 0; i < bmQubits.length; i++) {
        if (i < existingQubits.length) {
          wireMap.set(bmQubits[i].idx, existingQubits[i].idx);
        }
      }
    }

    // Add new wires only for benchmark wires that couldn't be mapped to existing ones
    const newWires = [...wires];
    let nextQubitCount = qubitCount;
    let nextQumodeCount = wires.filter(w => w.type === 'qumode').length;

    for (let i = existingQumodes.length; i < bmQumodes.length; i++) {
      const newIdx = newWires.length;
      wireMap.set(bmQumodes[i].idx, newIdx);
      newWires.push({
        id: `wire-qumode-${nextQumodeCount}`,
        type: 'qumode',
        index: nextQumodeCount,
        initialState: bmQumodes[i].wire.initialState,
      });
      nextQumodeCount++;
    }

    const qubitStartIdx = reuseQubits ? existingQubits.length : 0;
    for (let i = qubitStartIdx; i < bmQubits.length; i++) {
      const newIdx = newWires.length;
      wireMap.set(bmQubits[i].idx, newIdx);
      newWires.push({
        id: `wire-qubit-${nextQubitCount}`,
        type: 'qubit',
        index: nextQubitCount,
        initialState: bmQubits[i].wire.initialState,
      });
      nextQubitCount++;
    }

    // Calculate x-offset: start after the last existing gate
    const maxExistingX = elements.reduce((max, el) => Math.max(max, el.position.x), 0);
    const xOffset = maxExistingX + 80;

    // Remap benchmark elements
    const remappedElements = bmElements.map((el) => ({
      ...el,
      id: `${el.id}-appended-${Date.now()}`,
      wireIndex: wireMap.get(el.wireIndex) ?? el.wireIndex,
      targetWireIndices: el.targetWireIndices?.map(t => wireMap.get(t) ?? t),
      position: { x: el.position.x + xOffset, y: el.position.y },
    }));

    setWires(newWires);
    setElements([...elements, ...remappedElements]);
    setFockTruncation(Math.max(fockTruncation, newFock));
    setQubitCount(nextQubitCount);
    setQumodeCount(newWires.filter(w => w.type === 'qumode').length);
    setSimulationResult(null);
  }, [wires, elements, qubitCount, fockTruncation]);

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      {/* Header */}
      <header className="bg-slate-800 border-b border-slate-700 px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 via-purple-400 to-emerald-400 bg-clip-text text-transparent">
              HyQSim-AI
            </h1>
            <p className="text-sm text-slate-400">Hybrid CV-DV Quantum Circuit Simulator</p>
            <a
              href="https://github.com/shubdeepmohapatra01/HyQSim-AI"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors mt-0.5 inline-block"
            >
              github.com/shubdeepmohapatra01/HyQSim-AI
            </a>
          </div>
          <div className="flex items-center gap-6">
            {/* Backend toggle */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Backend:</span>
              <div className="flex bg-slate-700 rounded-md p-0.5">
                <button
                  onClick={() => setBackend('browser')}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    backend === 'browser'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  Browser
                </button>
                <button
                  onClick={() => setBackend('python')}
                  disabled={!backendAvailable}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    backend === 'python'
                      ? 'bg-purple-600 text-white'
                      : backendAvailable
                        ? 'text-slate-300 hover:text-white'
                        : 'text-slate-500 cursor-not-allowed'
                  }`}
                  title={backendAvailable ? 'Use Python backend' : 'Python backend not available'}
                >
                  Python
                </button>
              </div>
              {/* Backend status indicator */}
              <div className="flex items-center gap-1">
                <div
                  className={`w-2 h-2 rounded-full ${
                    backendChecking
                      ? 'bg-yellow-500 animate-pulse'
                      : backendAvailable
                        ? 'bg-green-500'
                        : 'bg-red-500'
                  }`}
                />
                <span className="text-[10px] text-slate-500">
                  {backendChecking ? 'checking...' : backendAvailable ? 'connected' : 'offline'}
                </span>
              </div>
            </div>

            {/* MCP bridge — drive this canvas from Claude Desktop / Claude Code */}
            <McpSessionBadge
              enabled={mcpEnabled}
              status={mcpStatus}
              code={mcpCode}
              error={mcpError}
              onToggle={toggleMcp}
            />

            {/* Benchmarks + Import/Export */}
            <div className="flex items-center gap-1">
              <BenchmarkMenu onLoadBenchmark={handleLoadBenchmark} hasExistingCircuit={wires.length > 0} hasExistingQubits={wires.some(w => w.type === 'qubit')} />
              <button
                onClick={() => setQiskitIOMode('import')}
                className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded transition-colors"
                title="Import bosonic qiskit code"
              >
                Import
              </button>
              <button
                onClick={() => setQiskitIOMode('export')}
                disabled={elements.length === 0}
                className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Export as bosonic qiskit code"
              >
                Export
              </button>
              <button
                onClick={handleClearCanvas}
                disabled={wires.length === 0}
                className="px-2 py-1 text-xs bg-red-900 hover:bg-red-800 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                title="Clear all wires and gates"
              >
                Clear
              </button>
            </div>

            <div className="flex flex-col items-end gap-0.5">
              <span className="text-xs text-slate-500">
                CV-DV Hybrid | Fock: {fockTruncation}
              </span>
              <span className="text-xs text-slate-600">
                {elements.length} gate{elements.length !== 1 ? 's' : ''} | {wires.length} wire{wires.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-col h-[calc(100vh-80px)]">
        <div className="flex flex-1 min-h-0">
          {/* Left sidebar - Gate Palette */}
          <aside className="w-64 p-4 border-r border-slate-700 overflow-hidden">
            <GatePalette
              onDragStart={handleDragStart}
              savedCustomGates={savedCustomGates}
              onRemoveCustomGate={handleRemoveCustomGate}
            />
          </aside>

          {/* Center - Circuit Canvas + Chat Panel */}
          <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="flex-1 min-h-0 p-4">
              <CircuitCanvas
                wires={wires}
                elements={elements}
                onAddWire={handleAddWire}
                onDropGate={handleDropGate}
                onRemoveWire={handleRemoveWire}
                onRemoveElement={handleRemoveElement}
                onElementClick={handleElementClick}
                onWireInitialStateChange={handleWireInitialStateChange}
                gates={gatesMap}
              />
            </div>
            <ChatPanel
              wires={wires}
              elements={elements}
              onAddWire={handleAddWire}
              onAddElement={handleAddElement}
              onApplyCircuit={handleImportCircuit}
              onRemoveElement={handleRemoveElement}
              onClearCanvas={handleClearCanvas}
              onRunSimulation={handleRunSimulation}
              onFockTruncationChange={setFockTruncation}
              canvasVersion={canvasVersion}
              simulationResult={simulationResult}
              fockTruncation={fockTruncation}
              backend={backend}
            />
          </main>

          {/* Right sidebar - Display Panel */}
          <aside className="w-80 p-4 border-l border-slate-700 overflow-hidden">
            <DisplayPanel
              wires={wires}
              fockTruncation={fockTruncation}
              onFockTruncationChange={setFockTruncation}
              simulationResult={simulationResult}
              onRunSimulation={handleRunSimulation}
              isSimulating={isSimulating}
              backend={backend}
              postSelections={postSelections}
              onPostSelectionsChange={setPostSelections}
              shots={shots}
              onShotsChange={setShots}
              measuredWireIndices={elements.filter(e => e.gateId === 'measure').map(e => e.wireIndex)}
            />
          </aside>
        </div>

      </div>

      {/* Gate Parameter Editor Modal */}
      {selectedElement && (() => {
        // Get the current element from the array (not the stale selectedElement)
        const currentElement = elements.find(e => e.id === selectedElement.id);
        if (!currentElement) return null;
        const gate = gatesMap.get(currentElement.gateId);
        if (!gate) return null;
        return (
          <GateParameterEditor
            element={currentElement}
            gate={gate}
            onUpdateParameters={handleUpdateParameters}
            onUpdateGeneratorExpression={handleUpdateGeneratorExpression}
            onUpdateTargetWire={handleUpdateTargetWire}
            onSaveCustomGate={handleSaveCustomGate}
            wires={wires}
            onClose={() => setSelectedElement(null)}
          />
        );
      })()}

      {/* Rabi Oscillation Plot Modal */}
      {/* {jcSweepData && activeJCParams && (
        <RabiPlot
          data={jcSweepData}
          params={activeJCParams}
          onClose={() => setJcSweepData(null)}
        />
      )} */}

      {/* Import/Export Modal */}
      {qiskitIOMode && (
        <ImportExportModal
          mode={qiskitIOMode}
          wires={wires}
          elements={elements}
          fockTruncation={fockTruncation}
          onImport={handleImportCircuit}
          onClose={() => setQiskitIOMode(null)}
        />
      )}
    </div>
  );
}

export default App;
