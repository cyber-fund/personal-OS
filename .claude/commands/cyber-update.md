---
name: cyber-update
description: Update personal-OS skills and connectors from git
---

Pull latest updates from the personal-OS repository.

## Workflow

1. Run `git fetch origin main`
2. Show changelog: `git log HEAD..origin/main --oneline`
3. If changes exist:
   a. Ask user for approval
   b. `git pull origin main`
   c. Run `bun scripts/generate-mcp-config.ts` to regenerate `.mcp.json`
   d. Check for new required secrets in updated `connector.json` files
   e. If new secrets required: report which connectors need configuration
4. Report update summary

## Safety

- Never force-push or reset
- If merge conflicts: report to user, do not auto-resolve
- If new secrets required: connector marked as needing configuration
