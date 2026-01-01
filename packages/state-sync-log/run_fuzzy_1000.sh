#!/bin/bash
set -e

echo "Starting 1000 fuzzy sync test runs..."

for i in {1..1000}
do
   echo "--------------------------------------------------"
   echo "Run #$i"
   echo "--------------------------------------------------"
   if (( i % 2 == 0 )); then
      export IMMUTABLE_MODE="true"
      echo "Mode: Immutable"
   else
      export IMMUTABLE_MODE="false"
      echo "Mode: Mutable"
   fi

   pnpm test fuzzySync
done

echo "All 1000 runs passed successfully!"
