#!/bin/bash

# HyQSim Runner Script
# Usage: ./run.sh [command]
#   start     - Start both frontend and backend
#   stop      - Stop both frontend and backend
#   frontend  - Start frontend only
#   backend   - Start backend only
#   status    - Check if servers are running

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_PID_FILE="$PROJECT_DIR/.backend.pid"
FRONTEND_PID_FILE="$PROJECT_DIR/.frontend.pid"

# Detect Windows (Git Bash / MSYS2 / Cygwin)
is_windows() {
    case "$OSTYPE" in
        msys*|cygwin*|win32*) return 0 ;;
    esac
    case "$(uname -s 2>/dev/null)" in
        MINGW*|CYGWIN*|MSYS*) return 0 ;;
    esac
    return 1
}

# Kill a process (and its children) by PID
kill_pid() {
    local pid=$1
    if [ -z "$pid" ]; then return 1; fi
    if is_windows; then
        # //T kills child processes too (e.g. uvicorn workers, vite sub-processes)
        taskkill //PID "$pid" //F //T 2>/dev/null
    else
        # Kill entire process group so child processes don't linger
        kill -- -"$(ps -o pgid= "$pid" 2>/dev/null | tr -d ' ')" 2>/dev/null \
            || kill "$pid" 2>/dev/null
    fi
}

# Check whether a PID is still alive
pid_alive() {
    local pid=$1
    if [ -z "$pid" ]; then return 1; fi
    if is_windows; then
        tasklist //FI "PID eq $pid" 2>/dev/null | grep -q "$pid"
    else
        kill -0 "$pid" 2>/dev/null
    fi
}

start_backend() {
    echo "Starting Python backend on port 8000..."
    cd "$PROJECT_DIR/backend"
    if is_windows; then
        source "venv/Scripts/activate"
    else
        source "venv/bin/activate"
    fi
    uvicorn main:app --reload --port 8000 &
    local pid=$!
    echo "$pid" > "$BACKEND_PID_FILE"
    echo "Backend started (PID: $pid)"
}

start_frontend() {
    echo "Starting frontend on port 5173..."
    cd "$PROJECT_DIR/frontend"
    npm run dev &
    local pid=$!
    echo "$pid" > "$FRONTEND_PID_FILE"
    echo "Frontend started (PID: $pid)"
}

stop_server() {
    local name=$1
    local pid_file=$2

    if [ -f "$pid_file" ]; then
        local pid
        pid=$(cat "$pid_file")
        rm -f "$pid_file"
        if kill_pid "$pid"; then
            echo "$name stopped (PID: $pid)"
        else
            echo "$name was not running"
        fi
    else
        # Fallback: pattern-based kill for Unix when no PID file exists
        if ! is_windows; then
            if [ "$name" = "Backend" ]; then
                pkill -f "uvicorn main:app" 2>/dev/null && echo "$name stopped" || echo "$name was not running"
            else
                pkill -f "vite" 2>/dev/null && echo "$name stopped" || echo "$name was not running"
            fi
        else
            echo "$name PID file not found; may not be running"
        fi
    fi
}

stop_all() {
    echo "Stopping servers..."
    stop_server "Backend"  "$BACKEND_PID_FILE"
    stop_server "Frontend" "$FRONTEND_PID_FILE"
}

status() {
    echo "Server Status:"
    if [ -f "$BACKEND_PID_FILE" ] && pid_alive "$(cat "$BACKEND_PID_FILE")"; then
        echo "  Backend:  Running (port 8000, PID: $(cat "$BACKEND_PID_FILE"))"
    else
        rm -f "$BACKEND_PID_FILE"
        echo "  Backend:  Stopped"
    fi
    if [ -f "$FRONTEND_PID_FILE" ] && pid_alive "$(cat "$FRONTEND_PID_FILE")"; then
        echo "  Frontend: Running (port 5173, PID: $(cat "$FRONTEND_PID_FILE"))"
    else
        rm -f "$FRONTEND_PID_FILE"
        echo "  Frontend: Stopped"
    fi
}

case "$1" in
    start)
        stop_all
        sleep 1
        start_backend
        sleep 2
        start_frontend
        echo ""
        echo "HyQSim is running!"
        echo "  Frontend: http://localhost:5173"
        echo "  Backend:  http://localhost:8000"
        echo ""
        echo "Run './run.sh stop' to stop servers"
        ;;
    stop)
        stop_all
        ;;
    frontend)
        start_frontend
        ;;
    backend)
        start_backend
        ;;
    status)
        status
        ;;
    *)
        echo "HyQSim Runner"
        echo ""
        echo "Usage: ./run.sh [command]"
        echo ""
        echo "Commands:"
        echo "  start     Start both frontend and backend"
        echo "  stop      Stop both frontend and backend"
        echo "  frontend  Start frontend only"
        echo "  backend   Start backend only"
        echo "  status    Check server status"
        ;;
esac
