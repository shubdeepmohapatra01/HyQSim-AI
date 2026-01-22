#!/bin/bash

# HyQSim Runner Script
# Usage: ./run.sh [command]
#   start     - Start both frontend and backend
#   stop      - Stop both frontend and backend
#   frontend  - Start frontend only
#   backend   - Start backend only
#   status    - Check if servers are running

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

start_backend() {
    echo "Starting Python backend on port 8000..."
    cd "$PROJECT_DIR/backend"
    source venv/bin/activate
    uvicorn main:app --reload --port 8000 &
    echo "Backend started (PID: $!)"
}

start_frontend() {
    echo "Starting frontend on port 5173..."
    cd "$PROJECT_DIR/frontend"
    npm run dev &
    echo "Frontend started"
}

stop_all() {
    echo "Stopping servers..."
    pkill -f "uvicorn main:app" 2>/dev/null && echo "Backend stopped" || echo "Backend was not running"
    pkill -f "vite" 2>/dev/null && echo "Frontend stopped" || echo "Frontend was not running"
}

status() {
    echo "Server Status:"
    if pgrep -f "uvicorn main:app" > /dev/null; then
        echo "  Backend:  Running (port 8000)"
    else
        echo "  Backend:  Stopped"
    fi
    if pgrep -f "vite" > /dev/null; then
        echo "  Frontend: Running (port 5173)"
    else
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
