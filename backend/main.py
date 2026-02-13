"""
HyQSim Backend - FastAPI server for quantum simulations.

Run with: uvicorn main:app --reload --port 8000
"""

import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from simulation.models import (
    SimulationRequest, SimulationResponse,
    ImportRequest, ImportResponse,
    ExportRequest, ExportResponse,
)
from simulation.bosonic import run_bosonic_simulation, HAS_BOSONIC
from simulation.qiskit_io import parse_bosonic_qiskit, generate_bosonic_qiskit

# Get allowed origins from environment variable or use defaults
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "").split(",") if os.environ.get("ALLOWED_ORIGINS") else []
ALLOWED_ORIGINS.extend([
    "http://localhost:5173",  # Vite dev server
    "http://localhost:3000",  # Alternative frontend port
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
    "https://webpublishing.oit.ncsu.edu",  # NC State web publishing
])
# Filter out empty strings
ALLOWED_ORIGINS = [origin for origin in ALLOWED_ORIGINS if origin]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    # Startup
    print("=" * 50)
    print("HyQSim Backend Starting...")
    print(f"  bosonic-qiskit available: {HAS_BOSONIC}")
    print("=" * 50)
    yield
    # Shutdown
    print("HyQSim Backend Shutting down...")


app = FastAPI(
    title="HyQSim Backend",
    description="Hybrid CV-DV Quantum Simulator API",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS middleware to allow frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    """Health check endpoint."""
    return {
        "service": "HyQSim Backend",
        "status": "running",
        "backends": {
            "bosonic-qiskit": HAS_BOSONIC,
        }
    }


@app.get("/health")
async def health():
    """Health check for monitoring."""
    return {"status": "healthy"}


@app.post("/simulate", response_model=SimulationResponse)
async def simulate(request: SimulationRequest):
    """
    Run a quantum circuit simulation.

    Args:
        request: SimulationRequest containing:
            - wires: List of qubit/qumode wires
            - elements: List of gate elements with positions and parameters
            - fockTruncation: Fock space truncation for qumodes

    Returns:
        SimulationResponse with qubit and qumode final states
    """
    if not HAS_BOSONIC:
        raise HTTPException(
            status_code=503,
            detail="bosonic-qiskit not installed. Run: pip install c2qa-qiskit"
        )

    result = run_bosonic_simulation(request)

    if not result.success:
        raise HTTPException(
            status_code=500,
            detail=f"Simulation failed: {result.error}"
        )

    return result


@app.post("/simulate/preview")
async def simulate_preview(request: SimulationRequest):
    """
    Quick preview simulation with reduced precision.
    Uses smaller Fock truncation for faster results.
    """
    # Cap Fock truncation for preview
    preview_request = SimulationRequest(
        wires=request.wires,
        elements=request.elements,
        fockTruncation=min(request.fockTruncation, 8)
    )

    return await simulate(preview_request)


@app.post("/import", response_model=ImportResponse)
async def import_circuit(request: ImportRequest):
    """Parse bosonic qiskit code and return HyQSim circuit data."""
    try:
        return parse_bosonic_qiskit(request.code)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/export", response_model=ExportResponse)
async def export_circuit(request: ExportRequest):
    """Generate bosonic qiskit code from HyQSim circuit data."""
    try:
        return generate_bosonic_qiskit(request.wires, request.elements, request.fockTruncation)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
