# HyQSim Test Documentation

## Test Files

| File | What it tests | Dependencies |
|------|--------------|--------------|
| `test_qiskit_io.py` | Import/export parsing & code generation | `pydantic` only |
| `test_simulator.py` | Full simulation pipeline — physics correctness | `bosonic-qiskit`, `qiskit`, `qutip`, `numpy` |

## Running Tests

```bash
cd backend

# IO tests (always work, no quantum libs needed)
python3 -m pytest tests/test_qiskit_io.py -v

# Simulator tests (need bosonic-qiskit installed)
python3 -m pytest tests/test_simulator.py -v

# All tests
python3 -m pytest tests/ -v
```

Simulator tests auto-skip if `bosonic-qiskit` is not installed.

---

## test_simulator.py — Full Pipeline Tests

### Circuit Builder Helpers

Every test uses these helpers to define circuits concisely:

```python
# Define wires
qubit(wire_index, initial_state="0")
qumode(wire_index, initial_state=0)

# Define gates
gate("h", wire=1)
gate("displace", wire=0, params={"alpha_re": 2.0, "alpha_im": 0.0})
gate("cdisp", wire=1, target=0, params={"alpha_re": 1.0, "alpha_im": 0.0})
gate("cnot", wire=1, target=2)

# Run circuit
result = run_circuit(wires=[...], gates=[...], fock=8)
```

### Assertion Helpers

```python
assert_bloch(state, x=..., y=..., z=..., tol=0.15)   # Bloch vector components
assert_fock_peak(state, n=0)                            # Highest probability Fock state
assert_mean_photon(state, expected=1.0, tol=0.5)        # <n>
assert_vacuum(state, tol=0.05)                           # P(0) ~ 1, <n> ~ 0
assert_fock_prob(state, n=2, expected=0.3, tol=0.1)     # P(|n>)
```

---

### 1. Pure DV (Qubit-Only) Tests — `TestPureDV`

| Test | Circuit | Expected outcome |
|------|---------|-----------------|
| `test_identity_qubit_in_zero` | No gates | Qubit at +z, qumode in vacuum |
| `test_hadamard` | H\|0> | Bloch +x (the \|+> state) |
| `test_pauli_x` | X\|0> | Bloch -z (the \|1> state) |
| `test_pauli_z` | Z\|0> | Bloch +z (global phase only) |
| `test_hadamard_twice` | HH\|0> | Bloch +z (back to \|0>) |
| `test_x_then_hadamard` | HX\|0> | Bloch -x (the \|-> state) |
| `test_rx_pi` | Rx(pi)\|0> | Bloch -z |
| `test_ry_pi_half` | Ry(pi/2)\|0> | Bloch +x |

### 2. Pure CV (Qumode-Only) Tests — `TestPureCV`

| Test | Circuit | Expected outcome |
|------|---------|-----------------|
| `test_vacuum` | No gates | P(0)~1, \<n>=0 |
| `test_displacement_real` | D(1)\|0> | \<n> ~ 1.0 (coherent state) |
| `test_displacement_larger` | D(2)\|0> | \<n> ~ 4.0 |
| `test_squeeze` | S(0.5)\|0> | \<n> ~ sinh²(0.5) ≈ 0.27 |
| `test_rotation_preserves_vacuum` | R(pi/3)\|0> | Still vacuum |
| `test_displace_then_rotate` | R(pi/4) D(1.5)\|0> | \<n> preserved at 2.25 |
| `test_fock_1_initial_state` | \|1> initial | \<n>=1, peak at n=1 |

### 3. Hybrid CV-DV Tests — `TestHybrid`

| Test | Circuit | Expected outcome |
|------|---------|-----------------|
| `test_cd_creates_entanglement` | H + CD(2) | Qubit Bloch length < 1 (mixed/entangled) |
| `test_cd_on_zero_qubit` | \|0> + CD(1.5) | Qubit stays \|0>, qumode displaced |
| `test_cr_on_vacuum` | H + CR(pi/4) on vacuum | Vacuum unchanged (eigenstate of rotation) |
| `test_qubit_unaffected_by_cv_gate` | H on qubit, D(2) on qumode | Qubit stays \|+>, qumode coherent |

### 4. Validation Tests — `TestValidation`

| Test | Input | Expected |
|------|-------|----------|
| `test_fock_truncation_not_power_of_2` | fock=6 | Fails with "power of 2" error |
| `test_no_qumodes_fails` | Only qubits | Fails (bosonic-qiskit requires qumode) |
| `test_unsupported_gate` | Unknown gate ID | Fails validation |

---

## Adding New Circuit Tests

1. Add a new class or method in `test_simulator.py`
2. Use `qubit()`, `qumode()`, `gate()`, `run_circuit()` helpers
3. Use `assert_bloch()`, `assert_mean_photon()`, etc. for verification
4. Commented-out examples for cat states and Bell states are at the bottom of the file

Example:
```python
class TestMyCircuit:
    def test_something(self):
        r = run_circuit(
            wires=[qumode(0), qubit(1)],
            gates=[
                gate("h", wire=1, x=10),
                gate("cdisp", wire=1, target=0, x=20,
                     params={"alpha_re": 2.0, "alpha_im": 0.0}),
            ],
            fock=8,
        )
        assert r.success
        assert_mean_photon(r.qumodeStates[0], expected=2.0, tol=1.0)
```

---

## test_qiskit_io.py — Import/Export Tests

Compact tests for the AST parser and code generator. 10 tests covering:
- Import: DV gates, CV displacement with complex params, hybrid CD, syntax errors
- Export: DV code gen, CV code gen, hybrid code gen, empty circuit errors
- Round-trip: export then import preserves gate sequence
