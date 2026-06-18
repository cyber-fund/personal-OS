#!/bin/bash
# Stop hook: check if project files were modified and prompt Claude to update status

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VAULT_LINK="$SCRIPT_DIR/../vault"

# Resolve symlink (macOS-compatible, no readlink -f)
if [ -L "$VAULT_LINK" ]; then
  VAULT_PATH="$(cd "$(dirname "$VAULT_LINK")" && cd "$(readlink "$VAULT_LINK")" && pwd)"
else
  VAULT_PATH="$(cd "$VAULT_LINK" && pwd)"
fi

CHECKPOINT_FILE="$VAULT_PATH/.last-context-sync"
PROJECTS_DIR="$VAULT_PATH/private/projects"

# If no projects dir, exit clean
if [ ! -d "$PROJECTS_DIR" ]; then
  exit 0
fi

# Get checkpoint time (epoch seconds), default to 0
if [ -f "$CHECKPOINT_FILE" ]; then
  LAST_SYNC=$(cat "$CHECKPOINT_FILE")
else
  LAST_SYNC=0
fi

CURRENT_TIME=$(date +%s)

# First run — create checkpoint and exit, don't flood with updates
if [ "$LAST_SYNC" -eq 0 ]; then
  echo "$CURRENT_TIME" > "$CHECKPOINT_FILE"
  exit 0
fi

# Find modified projects (excluding status.md to prevent loops)
MODIFIED_PROJECTS=""
for project_dir in "$PROJECTS_DIR"/*/; do
  if [ ! -d "$project_dir" ]; then continue; fi

  project_name=$(basename "$project_dir")

  # Find files modified after checkpoint, excluding status.md
  changed=$(find "$project_dir" -type f ! -name "status.md" -newer "$CHECKPOINT_FILE" 2>/dev/null | head -5)

  if [ -n "$changed" ]; then
    MODIFIED_PROJECTS="$MODIFIED_PROJECTS $project_name"
  fi
done

# Update checkpoint BEFORE outputting block decision.
# This ensures the next run (after Claude updates status.md) won't re-trigger,
# because: (a) checkpoint is fresh, and (b) status.md is excluded from find.
echo "$CURRENT_TIME" > "$CHECKPOINT_FILE"

# If no modified projects, exit clean
if [ -z "$MODIFIED_PROJECTS" ]; then
  exit 0
fi

# Trim leading space
MODIFIED_PROJECTS=$(echo "$MODIFIED_PROJECTS" | xargs)

cat <<EOF
{
  "decision": "block",
  "reason": "Project files were modified during this session. Please update status.md for these projects: $MODIFIED_PROJECTS. For each, read the current status.md, update the '## Current state' section with what was done in this session, update '## Last activity' with today's date, and update '## In progress' / '## Next' if relevant. Then continue."
}
EOF
