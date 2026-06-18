#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="$SCRIPT_DIR/touch-id-helper"

# Check if already compiled
if [ -f "$OUTPUT" ]; then
  echo "Touch ID helper already built at $OUTPUT"
  exit 0
fi

# Check if swiftc is available
if ! command -v swiftc &> /dev/null; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Swift compiler (swiftc) not found."
  echo ""
  echo "  personal-OS needs it to build the Touch ID helper."
  echo "  Install Xcode Command Line Tools by running:"
  echo ""
  echo "    xcode-select --install"
  echo ""
  echo "  This opens a system dialog — click 'Install',"
  echo "  wait for it to complete (~1-2 min on fast internet),"
  echo "  then re-run the personal-OS setup."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # Attempt automatic install (triggers system dialog)
  xcode-select --install 2>/dev/null || true

  echo "Waiting for Xcode Command Line Tools installation..."

  # Poll until swiftc becomes available (max 5 minutes)
  for i in $(seq 1 60); do
    if command -v swiftc &> /dev/null; then
      echo "Swift compiler installed successfully."
      break
    fi
    sleep 5
  done

  # Final check
  if ! command -v swiftc &> /dev/null; then
    echo "ERROR: Swift compiler still not available after waiting."
    echo "Please install manually: xcode-select --install"
    echo "Then re-run: bash connectors/_shared/touch-id/build.sh"
    exit 1
  fi
fi

# Compile
echo "Compiling Touch ID helper..."
swiftc -o "$OUTPUT" "$SCRIPT_DIR/touch-id-helper.swift" -framework LocalAuthentication
chmod +x "$OUTPUT"
echo "Touch ID helper built successfully at $OUTPUT"
