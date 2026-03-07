#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PRIMARY_URL="http://localhost:5001"
AGENT_URL="http://localhost:5002"
AGENT_INTERNAL_URL="http://dockge-test-agent:5001"
API_KEY="test-key"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; }
pass()  { echo -e "${GREEN}[PASS]${NC} $*"; }

api() {
    # api METHOD URL [extra curl args...]
    local method="$1" url="$2"
    shift 2
    curl -sf -X "$method" "$url" -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" "$@"
}

wait_for_healthy() {
    local url="$1"
    local name="$2"
    local max_wait="${3:-60}"
    local elapsed=0

    info "Waiting for $name to be healthy at $url..."
    while [ $elapsed -lt $max_wait ]; do
        if curl -sf "$url/api/health" > /dev/null 2>&1; then
            pass "$name is healthy (${elapsed}s)"
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    fail "$name did not become healthy within ${max_wait}s"
    return 1
}

wait_for_agent_connected() {
    local max_wait="${1:-60}"
    local elapsed=0

    info "Waiting for agent to be connected to primary..."
    while [ $elapsed -lt $max_wait ]; do
        local status
        status=$(api GET "$PRIMARY_URL/api/agents/status" 2>/dev/null) || true
        if echo "$status" | grep -q '"connected":true'; then
            local agent_connected
            agent_connected=$(echo "$status" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for a in data.get('agents', []):
    if a.get('endpoint') and a.get('connected'):
        print('yes')
        break
" 2>/dev/null) || true
            if [ "$agent_connected" = "yes" ]; then
                pass "Agent connected to primary (${elapsed}s)"
                return 0
            fi
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    fail "Agent did not connect within ${max_wait}s"
    return 1
}

case "${1:-}" in
  build)
    info "Building dockge-test image (clean production)..."
    docker build --network host -f ../../docker/Dockerfile -t dockge-test:latest ../..
    info "Building dockge-test-noauth image (test layer)..."
    docker build -f Dockerfile.test -t dockge-test-noauth:latest .
    info "Pre-pulling docker:cli..."
    docker pull docker:cli
    pass "Build complete"
    ;;

  up)
    info "Starting primary..."
    docker compose -f primary/compose.yaml up -d
    info "Starting agent..."
    docker compose -f stacks/agent/compose.yaml up -d
    echo ""
    info "Primary: $PRIMARY_URL"
    info "Agent:   $AGENT_URL"
    echo ""
    info "Both instances run with disableAuth (via test entrypoint)"
    info "API key: $API_KEY"
    info "Use './run-test.sh test' for automated end-to-end test"
    ;;

  down)
    info "Stopping all..."
    docker compose -f stacks/agent/compose.yaml down 2>/dev/null || true
    docker compose -f primary/compose.yaml down 2>/dev/null || true
    info "Cleaning up data..."
    rm -rf primary/data primary/stacks agent-data
    docker ps -a --filter "name=dockge-self-updater" --format "{{.ID}}" | xargs -r docker rm -f 2>/dev/null || true
    docker network rm dockge-test-net 2>/dev/null || true
    pass "Cleanup complete"
    ;;

  logs)
    echo "=== PRIMARY ==="
    docker logs dockge-test-primary --tail 30 2>&1
    echo ""
    echo "=== AGENT ==="
    docker logs dockge-test-agent --tail 30 2>&1
    ;;

  status)
    echo "=== Containers ==="
    docker ps -a --filter "name=dockge-test" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""
    echo "=== Self-updater containers ==="
    docker ps -a --filter "name=dockge-self-updater" --format "table {{.Names}}\t{{.Status}}"
    echo ""
    echo "=== Agent API status ==="
    api GET "$PRIMARY_URL/api/agents/status" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "(primary not reachable)"
    ;;

  test)
    echo "============================================"
    echo "  Self-Update End-to-End Test"
    echo "============================================"
    echo ""

    # Step 0: Clean slate
    info "Step 0: Clean up any previous run..."
    docker compose -f stacks/agent/compose.yaml down 2>/dev/null || true
    docker compose -f primary/compose.yaml down 2>/dev/null || true
    rm -rf primary/data primary/stacks agent-data
    docker ps -a --filter "name=dockge-self-updater" --format "{{.ID}}" | xargs -r docker rm -f 2>/dev/null || true
    docker network rm dockge-test-net 2>/dev/null || true
    sleep 1

    # Step 1: Start primary
    info "Step 1: Starting primary..."
    docker compose -f primary/compose.yaml up -d
    wait_for_healthy "$PRIMARY_URL" "Primary"

    # Step 2: Start agent
    info "Step 2: Starting agent..."
    docker compose -f stacks/agent/compose.yaml up -d
    wait_for_healthy "$AGENT_URL" "Agent"

    # Give both instances a moment to fully initialize (disableAuth auto-login, etc.)
    sleep 3

    # Step 3: Register agent on primary
    info "Step 3: Registering agent on primary..."
    REGISTER_RESULT=$(api POST "$PRIMARY_URL/api/agents" \
      -d "{\"url\": \"$AGENT_INTERNAL_URL\", \"username\": \"admin\", \"password\": \"admin\"}" 2>&1) || true

    if echo "$REGISTER_RESULT" | grep -q '"ok":true'; then
        pass "Agent registered successfully"
    else
        fail "Agent registration failed: $REGISTER_RESULT"
        echo ""
        fail "=== Primary logs ==="
        docker logs dockge-test-primary --tail 20 2>&1
        exit 1
    fi

    # Step 4: Wait for agent to connect
    sleep 3
    wait_for_agent_connected 30

    # Step 5: Verify agent stack is visible
    info "Step 5: Checking agent stack visibility..."
    STACKS=$(api GET "$PRIMARY_URL/api/stacks" 2>/dev/null) || true
    AGENT_STACK=$(echo "$STACKS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for s in data.get('stacks', []):
    if s.get('name') == 'agent' and s.get('endpoint'):
        print(json.dumps(s))
        break
" 2>/dev/null) || true

    if [ -n "$AGENT_STACK" ]; then
        pass "Agent's 'agent' stack is visible on primary"
        info "  Stack: $AGENT_STACK"
    else
        fail "Agent's 'agent' stack not found on primary"
        info "  All stacks: $STACKS"
        exit 1
    fi

    # Extract endpoint for the agent
    AGENT_ENDPOINT=$(echo "$AGENT_STACK" | python3 -c "import sys,json; print(json.load(sys.stdin)['endpoint'])" 2>/dev/null)
    info "  Agent endpoint: $AGENT_ENDPOINT"

    # Step 5.1: API auth — request without key returns 401
    info "Step 5.1: Verifying API auth requirement..."
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$PRIMARY_URL/api/stacks" 2>/dev/null) || true
    if [ "$HTTP_CODE" = "401" ]; then
        pass "Unauthenticated request returns 401"
    else
        fail "Expected 401, got $HTTP_CODE"
        exit 1
    fi

    # Step 5.2: Auto-update toggle roundtrip
    info "Step 5.2: Testing auto-update toggle..."
    api PUT "$PRIMARY_URL/api/stacks/agent/auto-update?endpoint=$AGENT_ENDPOINT" \
      -d '{"enabled": true}' > /dev/null
    AU_STATUS=$(api GET "$PRIMARY_URL/api/stacks/agent/auto-update?endpoint=$AGENT_ENDPOINT" 2>/dev/null)
    AU_ENABLED=$(echo "$AU_STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('autoUpdate', False))" 2>/dev/null)
    if [ "$AU_ENABLED" = "True" ]; then
        pass "Auto-update enabled successfully"
    else
        fail "Auto-update not enabled: $AU_STATUS"
        exit 1
    fi
    api PUT "$PRIMARY_URL/api/stacks/agent/auto-update?endpoint=$AGENT_ENDPOINT" \
      -d '{"enabled": false}' > /dev/null
    AU_STATUS2=$(api GET "$PRIMARY_URL/api/stacks/agent/auto-update?endpoint=$AGENT_ENDPOINT" 2>/dev/null)
    AU_ENABLED2=$(echo "$AU_STATUS2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('autoUpdate', False))" 2>/dev/null)
    if [ "$AU_ENABLED2" = "False" ]; then
        pass "Auto-update disabled successfully"
    else
        fail "Auto-update not disabled: $AU_STATUS2"
        exit 1
    fi

    # Step 5.3: Check updates
    info "Step 5.3: Testing check-updates endpoint..."
    CHECK_RESULT=$(api POST "$PRIMARY_URL/api/stacks/agent/check-updates?endpoint=$AGENT_ENDPOINT" 2>&1) || true
    if echo "$CHECK_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('ok') == True" 2>/dev/null; then
        pass "Check updates completed"
    else
        warn "Check updates response: $CHECK_RESULT (may be expected without skopeo)"
    fi

    # Step 5.4: Scheduler CRUD
    info "Step 5.4: Testing scheduler settings..."
    SCHED=$(api GET "$PRIMARY_URL/api/scheduler" 2>/dev/null)
    if echo "$SCHED" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'cronExpression' in d" 2>/dev/null; then
        pass "Scheduler GET returns settings"
    else
        fail "Scheduler GET missing expected fields: $SCHED"
        exit 1
    fi
    # Update cron and verify roundtrip
    api PUT "$PRIMARY_URL/api/scheduler" -d '{"cronExpression": "0 4 * * *"}' > /dev/null
    SCHED2=$(api GET "$PRIMARY_URL/api/scheduler" 2>/dev/null)
    CRON=$(echo "$SCHED2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cronExpression',''))" 2>/dev/null)
    if [ "$CRON" = "0 4 * * *" ]; then
        pass "Scheduler cron updated successfully"
    else
        fail "Scheduler cron not updated: $CRON"
        exit 1
    fi
    # Restore default
    api PUT "$PRIMARY_URL/api/scheduler" -d '{"cronExpression": "0 3 * * *"}' > /dev/null

    # Step 5.5: Update history
    info "Step 5.5: Testing update history..."
    HIST=$(api GET "$PRIMARY_URL/api/update-history?limit=10" 2>/dev/null)
    if echo "$HIST" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('ok') == True and isinstance(d.get('entries', []), list)" 2>/dev/null; then
        pass "Update history returns a list"
    else
        fail "Update history unexpected format: $HIST"
        exit 1
    fi

    # Step 5.6: Error handling — nonexistent stack returns error, not crash
    info "Step 5.6: Testing error handling for nonexistent stack..."
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$PRIMARY_URL/api/stacks/nonexistent_stack_12345/stop" \
      -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" 2>/dev/null) || true
    if [ "$HTTP_CODE" = "404" ] || [ "$HTTP_CODE" = "500" ]; then
        pass "Stop nonexistent stack returns $HTTP_CODE (not crash)"
    else
        fail "Stop nonexistent stack unexpected code: $HTTP_CODE"
        exit 1
    fi

    # Step 5.7: Health endpoint returns version
    info "Step 5.7: Verifying health endpoint has version..."
    HEALTH=$(curl -sf "$PRIMARY_URL/api/health" 2>/dev/null)
    if echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('version')" 2>/dev/null; then
        pass "Health endpoint returns version"
    else
        fail "Health endpoint missing version: $HEALTH"
        exit 1
    fi

    # Step 5.8: /api/agents returns version
    info "Step 5.8: Verifying /api/agents includes version field..."
    AGENTS=$(api GET "$PRIMARY_URL/api/agents" 2>/dev/null)
    if echo "$AGENTS" | python3 -c "import sys,json; agents=json.load(sys.stdin)['agents']; assert any(a.get('version') for a in agents), 'No version in agents'" 2>/dev/null; then
        pass "/api/agents includes version"
    else
        fail "/api/agents missing version field: $AGENTS"
        exit 1
    fi

    # Step 6: Get agent container ID before update
    AGENT_CID_BEFORE=$(docker inspect --format '{{.Id}}' dockge-test-agent 2>/dev/null | head -c 12)
    info "Step 6: Agent container ID before update: $AGENT_CID_BEFORE"

    # Step 7: Trigger update on agent's self-stack
    info "Step 7: Triggering update on agent's 'agent' stack..."
    UPDATE_RESULT=$(api POST "$PRIMARY_URL/api/stacks/agent/update?endpoint=$AGENT_ENDPOINT" 2>&1) || true
    info "  Update response: $UPDATE_RESULT"

    # Step 8: Watch for self-update behavior
    info "Step 8: Monitoring self-update..."
    sleep 5

    # Check for self-updater container
    UPDATER=$(docker ps -a --filter "name=dockge-self-updater" --format "{{.Names}} {{.Status}}" 2>/dev/null)
    if [ -n "$UPDATER" ]; then
        pass "Self-updater container detected: $UPDATER"
    else
        warn "No self-updater container detected (may have already exited)"
    fi

    # Step 9: Wait for agent to come back
    info "Step 9: Waiting for agent to restart and become healthy..."
    sleep 10  # Give time for self-updater to do its thing

    if wait_for_healthy "$AGENT_URL" "Agent (post-update)" 60; then
        AGENT_CID_AFTER=$(docker inspect --format '{{.Id}}' dockge-test-agent 2>/dev/null | head -c 12)
        info "  Agent container ID after update: $AGENT_CID_AFTER"
        if [ "$AGENT_CID_BEFORE" != "$AGENT_CID_AFTER" ]; then
            pass "Agent container was recreated (new ID)"
        else
            warn "Agent container ID unchanged — image may not have changed (expected for same image)"
        fi
    else
        fail "Agent did not come back after update"
        echo ""
        fail "=== Agent logs ==="
        docker logs dockge-test-agent --tail 30 2>&1
        echo ""
        fail "=== Self-updater logs ==="
        docker ps -a --filter "name=dockge-self-updater" --format "{{.ID}}" | head -1 | xargs -r docker logs 2>&1 || echo "(no updater container)"
        exit 1
    fi

    # Step 10: Verify primary can still see agent
    info "Step 10: Checking if primary can see agent after restart..."
    sleep 5
    if wait_for_agent_connected 60; then
        pass "Primary reconnected to agent after self-update"
    else
        fail "Primary cannot see agent after self-update"
        exit 1
    fi

    # Step 11: Verify stacks are still visible
    info "Step 11: Final stack visibility check..."
    STACKS_FINAL=$(api GET "$PRIMARY_URL/api/stacks" 2>/dev/null) || true
    AGENT_STACK_FINAL=$(echo "$STACKS_FINAL" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for s in data.get('stacks', []):
    if s.get('name') == 'agent' and s.get('endpoint'):
        print('found')
        break
" 2>/dev/null) || true

    if [ "$AGENT_STACK_FINAL" = "found" ]; then
        pass "Agent stack still visible after self-update"
    else
        fail "Agent stack not visible after self-update"
        exit 1
    fi

    echo ""
    echo "============================================"
    pass "  ALL TESTS PASSED"
    echo "============================================"
    echo ""
    info "Run './run-test.sh down' to clean up"
    ;;

  *)
    echo "Usage: $0 {build|up|down|logs|status|test}"
    echo ""
    echo "Commands:"
    echo "  build   - Build dockge-test (clean) + dockge-test-noauth (test layer) images"
    echo "  up      - Start primary + agent containers"
    echo "  down    - Stop and clean up everything"
    echo "  logs    - Show container logs"
    echo "  status  - Show container and agent status"
    echo "  test    - Full automated end-to-end self-update test"
    exit 1
    ;;
esac
