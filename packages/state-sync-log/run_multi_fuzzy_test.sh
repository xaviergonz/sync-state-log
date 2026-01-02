#!/bin/bash

# Abort on Ctrl-C
trap "rm -f .test_runner.sh .fail_marker .fail_output; exit" INT

# Cleanup
rm -f .fail_marker .fail_output

# Configuration
RUNS=10000

# Create helper script
cat << 'EOF' > .test_runner.sh
#!/bin/bash
# Exit fast if global failure already happened
if [ -f .fail_marker ]; then exit 0; fi

ITER=$1
export FUZZY_REPLAY_FILE="fuzzy_failure_${ITER}.json"

# Run the test
OUT=$(pnpm test fuzzySync 2>&1)
RET=$?

if [ $RET -ne 0 ]; then
    # Atomic-ish check to capture first failure
    if [ ! -f .fail_marker ]; then
        touch .fail_marker
        echo "$OUT" > .fail_output
        echo "FAIL_TOKEN"
    fi
    exit 1
else
    echo "OK_TOKEN"
fi
EOF
chmod +x .test_runner.sh

# Detect cores
MAX_CORES=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 8)

if [ "$MAX_CORES" -le 2 ]; then
  CORES=$MAX_CORES
else
  CORES=$((MAX_CORES - 1))
fi

echo "Starting $RUNS fuzzy sync test runs using $CORES parallel processes..."

# Run xargs and pipe output to a loop for counting
# Process substitution or pipe used to maintain counter state
seq 1 "$RUNS" | xargs -P "$CORES" -I {} ./.test_runner.sh {} | \
while read line; do
    if [ "$line" == "OK_TOKEN" ]; then
        count=$((count + 1))
        # Print progress, overwriting the line
        printf "\r%d/%d" "$count" "$RUNS"
    elif [ "$line" == "FAIL_TOKEN" ]; then
        echo ""
        echo "--------------------------------------------------"
        echo "❌ FAILURE DETECTED"
        echo "--------------------------------------------------"
        if [ -f .fail_output ]; then
            cat .fail_output
        fi
        # Kill the loop and exit with error
        # We also want to stop xargs if possible, but exiting the read loop breaks the pipe
        # causing xargs to eventually stop writing and exit.
        exit 1
    fi
done

# Capture the exit code of the pipeline and check for failure marker
# The loop will have exited 1 if a failure was detected and FAIL_TOKEN was received.

if [ -f .fail_marker ]; then
    rm -f .test_runner.sh .fail_marker .fail_output
    exit 1
fi

echo ""
echo "✅ All $RUNS runs passed successfully!"
rm -f .test_runner.sh .fail_marker .fail_output
exit 0
