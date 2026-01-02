#!/bin/bash

# Abort on Ctrl-C
trap "rm -f .test_runner.sh .fail_marker .fail_output; exit" INT

# Cleanup
rm -f .fail_marker .fail_output

# Create helper script
cat << 'EOF' > .test_runner.sh
#!/bin/bash
# Exit fast if global failure already happened
if [ -f .fail_marker ]; then exit 0; fi

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

echo "Starting 1000 fuzzy sync test runs using $CORES parallel processes..."

# Run xargs and pipe output to a loop for counting
# Process substitution or pipe used to maintain counter state
seq 1 1000 | xargs -P "$CORES" -I {} ./.test_runner.sh {} | \
while read line; do
    if [ "$line" == "OK_TOKEN" ]; then
        count=$((count + 1))
        # Print progress, overwriting the line
        printf "\r%d/1000" "$count"
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
        rm -f .test_runner.sh .fail_marker .fail_output
        exit 1
    fi
done

# Capture the exit code of the pipeline
PIPE_STATUS=${PIPESTATUS[0]} # This might not work in all shells if not using bash array, but set -e handles it?
# Actually 'read' loop exit is what we care about mostly.
# If loop exited 1 (due to our explicit exit), the script should exit.
# But inside the pipe subshell, exit 1 might not kill the parent script unless we handle it.

if [ -f .fail_marker ]; then
    rm -f .test_runner.sh .fail_marker .fail_output
    exit 1
fi

echo ""
echo "✅ All 1000 runs passed successfully!"
rm -f .test_runner.sh .fail_marker .fail_output
exit 0
