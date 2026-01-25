"""Pydantic models for simulation requests and responses."""

from pydantic import BaseModel
from typing import Optional
from enum import Enum


class WireType(str, Enum):
    qubit = "qubit"
    qumode = "qumode"


class Wire(BaseModel):
    id: str
    type: WireType
    index: int
    # Initial state: for qubits '0', '1', '+', '-', 'i', '-i'; for qumodes 0-5 (Fock state)
    initialState: Optional[str | int] = None


class Position(BaseModel):
    x: float
    y: float


class CircuitElement(BaseModel):
    id: str
    gateId: str
    position: Position
    wireIndex: int
    targetWireIndices: Optional[list[int]] = None
    parameterValues: Optional[dict[str, float]] = None


class QubitPostSelection(BaseModel):
    """Post-selection settings for a qubit."""
    wireIndex: int
    outcome: int  # 0 or 1


class SimulationRequest(BaseModel):
    wires: list[Wire]
    elements: list[CircuitElement]
    fockTruncation: int = 10
    postSelections: Optional[list[QubitPostSelection]] = None  # Qubit post-selections


class ComplexNumber(BaseModel):
    re: float
    im: float


class QubitState(BaseModel):
    amplitude: tuple[ComplexNumber, ComplexNumber]
    blochVector: dict[str, float]  # x, y, z
    expectations: dict[str, float]  # sigmaX, sigmaY, sigmaZ


class QumodeState(BaseModel):
    fockAmplitudes: list[ComplexNumber]
    fockProbabilities: list[float]
    meanPhotonNumber: float
    # Optional: pre-rendered Wigner data
    wignerData: Optional[list[list[float]]] = None
    wignerRange: Optional[float] = None


class SimulationResponse(BaseModel):
    success: bool
    qubitStates: dict[int, QubitState]  # keyed by wire index
    qumodeStates: dict[int, QumodeState]  # keyed by wire index
    executionTime: float  # in seconds
    backend: str  # "bosonic-qiskit" or "qutip"
    error: Optional[str] = None
