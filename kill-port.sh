#!/usr/bin/env bash
# Kill process listening on a port. Default: 3000
# Usage: ./kill-port.sh [port]

PORT="${1:-3000}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 [port]"
  echo "  port: port number (default: 3000)"
  exit 1
fi

echo "Looking for process on port $PORT..."
PID=$(netstat -ano 2>/dev/null | grep ":$PORT" | grep LISTENING | awk '{print $NF}' | head -1)

if [ -z "$PID" ]; then
  echo "No process found on port $PORT"
  exit 0
fi

echo "Killing PID $PID..."
cmd //c "taskkill /PID $PID /F"
exit $?
