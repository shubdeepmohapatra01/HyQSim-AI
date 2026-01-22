#!/bin/bash

# HyQSim Installation Script
# Installs all dependencies for frontend and backend

set -e  # Exit on error

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "=========================================="
echo "HyQSim Installation"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check for required tools
check_requirements() {
    echo "Checking requirements..."

    # Check Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${RED}Error: Node.js is not installed${NC}"
        echo "Please install Node.js 18+ from https://nodejs.org/"
        exit 1
    fi
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        echo -e "${YELLOW}Warning: Node.js version 18+ recommended (found v$NODE_VERSION)${NC}"
    else
        echo -e "${GREEN}✓ Node.js $(node -v)${NC}"
    fi

    # Check npm
    if ! command -v npm &> /dev/null; then
        echo -e "${RED}Error: npm is not installed${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ npm $(npm -v)${NC}"

    # Check Python
    if command -v python3.12 &> /dev/null; then
        PYTHON_CMD="python3.12"
    elif command -v python3 &> /dev/null; then
        PYTHON_CMD="python3"
    else
        echo -e "${RED}Error: Python 3 is not installed${NC}"
        echo "Please install Python 3.10+ from https://python.org/"
        exit 1
    fi
    PYTHON_VERSION=$($PYTHON_CMD --version | cut -d' ' -f2)
    echo -e "${GREEN}✓ Python $PYTHON_VERSION${NC}"

    # Check git
    if ! command -v git &> /dev/null; then
        echo -e "${RED}Error: git is not installed${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ git $(git --version | cut -d' ' -f3)${NC}"

    echo ""
}

# Install frontend dependencies
install_frontend() {
    echo "=========================================="
    echo "Installing Frontend Dependencies"
    echo "=========================================="
    cd "$PROJECT_DIR/frontend"

    if [ -d "node_modules" ]; then
        echo "node_modules exists, running npm install to update..."
    fi

    npm install
    echo -e "${GREEN}✓ Frontend dependencies installed${NC}"
    echo ""
}

# Install backend dependencies
install_backend() {
    echo "=========================================="
    echo "Installing Backend Dependencies"
    echo "=========================================="
    cd "$PROJECT_DIR/backend"

    # Create virtual environment if it doesn't exist
    if [ ! -d "venv" ]; then
        echo "Creating Python virtual environment..."
        $PYTHON_CMD -m venv venv
    fi

    # Activate virtual environment
    source venv/bin/activate

    # Upgrade pip
    pip install --upgrade pip

    # Install requirements
    echo "Installing Python packages..."
    pip install -r requirements.txt

    echo -e "${GREEN}✓ Backend dependencies installed${NC}"
    echo ""
}

# Install bosonic-qiskit
install_bosonic_qiskit() {
    echo "=========================================="
    echo "Installing bosonic-qiskit"
    echo "=========================================="
    cd "$PROJECT_DIR"

    # Clone if not exists
    if [ ! -d "bosonic-qiskit" ]; then
        echo "Cloning bosonic-qiskit repository..."
        git clone https://github.com/C2QA/bosonic-qiskit.git
    else
        echo "bosonic-qiskit directory exists, pulling latest..."
        cd bosonic-qiskit
        git pull || true
        cd ..
    fi

    # Install in editable mode
    cd "$PROJECT_DIR/backend"
    source venv/bin/activate
    echo "Installing bosonic-qiskit in editable mode..."
    pip install -e ../bosonic-qiskit

    echo -e "${GREEN}✓ bosonic-qiskit installed${NC}"
    echo ""
}

# Verify installation
verify_installation() {
    echo "=========================================="
    echo "Verifying Installation"
    echo "=========================================="

    # Check frontend
    cd "$PROJECT_DIR/frontend"
    if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
        echo -e "${GREEN}✓ Frontend: OK${NC}"
    else
        echo -e "${RED}✗ Frontend: node_modules incomplete${NC}"
    fi

    # Check backend
    cd "$PROJECT_DIR/backend"
    source venv/bin/activate

    # Check bosonic-qiskit
    if python -c "from bosonic_qiskit import CVCircuit; print('bosonic-qiskit OK')" 2>/dev/null; then
        echo -e "${GREEN}✓ Backend: bosonic-qiskit available${NC}"
    else
        echo -e "${YELLOW}! Backend: bosonic-qiskit not available (Python backend won't work)${NC}"
    fi

    # Check qutip
    if python -c "import qutip; print('qutip OK')" 2>/dev/null; then
        echo -e "${GREEN}✓ Backend: qutip available${NC}"
    else
        echo -e "${YELLOW}! Backend: qutip not available${NC}"
    fi

    echo ""
}

# Main installation
main() {
    check_requirements
    install_frontend
    install_backend
    install_bosonic_qiskit
    verify_installation

    echo "=========================================="
    echo -e "${GREEN}Installation Complete!${NC}"
    echo "=========================================="
    echo ""
    echo "To start HyQSim, run:"
    echo "  ./run.sh start"
    echo ""
    echo "Or start components individually:"
    echo "  ./run.sh frontend   # Frontend only (browser simulation)"
    echo "  ./run.sh backend    # Backend only"
    echo ""
    echo "For more options:"
    echo "  ./run.sh"
    echo ""
}

# Run main
main
