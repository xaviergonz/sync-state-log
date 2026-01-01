#!/bin/bash
set -e

echo "Starting 1000 fuzzy sync test runs..."

for i in {1..1000}
do
   echo "--------------------------------------------------"
   echo "Run #$i"
   echo "--------------------------------------------------"
   pnpm test fuzzySync
done

echo "All 1000 runs passed successfully!"
