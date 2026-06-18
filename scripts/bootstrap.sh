#!/usr/bin/env bash
# personal-OS — SessionStart bootstrap
#
# Ensures Bun is installed, then delegates to setup.ts (which installs
# npm dependencies on first run) and collect.ts.
#
# This is the entry point for the Claude Code SessionStart hook — it must
# be a shell script so we can install Bun before invoking it.

set -e

# Ensure ~/.bun/bin is on PATH so subprocesses (Bun.spawn) can find bun
export PATH="$HOME/.bun/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "personal-OS: Bun not found, installing (one-time, ~10s)..."

  if ! command -v curl >/dev/null 2>&1; then
    echo "Error: curl is required to install Bun. Install curl or install Bun manually from https://bun.sh"
    exit 1
  fi

  if ! curl -fsSL https://bun.sh/install | bash; then
    echo "Error: failed to download Bun installer."
    echo "Check your internet connection or install manually from https://bun.sh"
    exit 1
  fi

  if ! command -v bun >/dev/null 2>&1; then
    echo "Error: Bun installed but not found on PATH."
    echo "Try restarting your terminal, or check $HOME/.bun/bin"
    exit 1
  fi

  echo "Bun installed: $(bun --version)"
  echo ""
fi

# Hand off to the TypeScript setup flow. On first run, setup.ts opens the
# browser wizard and exits 0 without creating ~/.cyboslite/config.json —
# skip collect.ts in that case so we don't print noise over the wizard prompt.
bun scripts/setup.ts --check
if [ -f "$HOME/.cyboslite/config.json" ]; then
  bun scripts/collect.ts
fi
