#!/usr/bin/env bash
set -euo pipefail

# Integration smoke-test for wg-to-ws
#
# Starts a UDP echo server, the wg-to-ws server, and the wg-to-ws client,
# sends a known payload via UDP, and confirms it is echoed back.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

UDP_ECHO_PORT=51900
WS_PORT=8090
LOCAL_UDP_PORT=51901
BASE_PATH="/wg"

cleanup() {
  echo "Cleaning up..."
  kill $ECHO_PID 2>/dev/null || true
  kill $SERVER_PID 2>/dev/null || true
  kill $CLIENT_PID 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

# 1. Start UDP echo server (python)
echo "=== 1. Starting UDP echo server on port $UDP_ECHO_PORT ==="
python3 -c "
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(('127.0.0.1', $UDP_ECHO_PORT))
while True:
    data, addr = s.recvfrom(4096)
    s.sendto(data, addr)
" &
ECHO_PID=$!
sleep 0.5

# 2. Start wg-to-ws server with --no-auth (no shared key for test)
echo "=== 2. Starting wg-to-ws server on port $WS_PORT ==="
WG_MODE=server \
  WS_BIND="0.0.0.0:$WS_PORT" \
  WS_BASE_PATH="$BASE_PATH" \
  WG_SERVER_ADDR="127.0.0.1:$UDP_ECHO_PORT" \
  WG_NO_AUTH=true \
  bun run "$PROJECT_DIR/src/server.ts" &
SERVER_PID=$!
sleep 1

# 3. Start wg-to-ws client with --no-auth
echo "=== 3. Starting wg-to-ws client on UDP $LOCAL_UDP_PORT ==="
WG_MODE=client \
  WG_LOCAL_PORT="$LOCAL_UDP_PORT" \
  WS_URL="ws://localhost:$WS_PORT$BASE_PATH" \
  WG_NO_AUTH=true \
  bun run "$PROJECT_DIR/src/client.ts" &
CLIENT_PID=$!
sleep 1.5

# 4. Send test payload and capture echo via python UDP client
echo "=== 4. Sending test payload and capturing echo ==="
TEST_PAYLOAD="hello-wg-over-ws-$(date +%s)"
echo "Payload: '$TEST_PAYLOAD'"

RESPONSE=$(python3 -c "
import socket, time

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(5)
s.bind(('127.0.0.1', 0))  # random source port
s.sendto(b'$TEST_PAYLOAD', ('127.0.0.1', $LOCAL_UDP_PORT))
time.sleep(1)
try:
    data, addr = s.recvfrom(4096)
    print(data.decode(), end='')
except socket.timeout:
    print('TIMEOUT', end='')
s.close()
")

echo "Response: '$RESPONSE'"

if [ "$RESPONSE" = "$TEST_PAYLOAD" ]; then
  echo ""
  echo "=== SUCCESS: Echo matches! ==="
else
  echo ""
  echo "=== FAILURE: Echo mismatch or timeout ==="
  echo "Expected: '$TEST_PAYLOAD'"
  echo "Got:      '$RESPONSE'"
  exit 1
fi
