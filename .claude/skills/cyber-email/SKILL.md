---
name: cyber-email
description: Process Gmail messages - read, draft replies, sync to vault.
---

# cyber-email Skill

Process unread emails. Draft replies (never auto-send), save context to vault.

## MCP Tools (Local Connector)

| Tool | Purpose |
|------|---------|
| `mcp__cybos-gmail__search_emails` | Search/query emails |
| `mcp__cybos-gmail__read_email` | Read full email content |
| `mcp__cybos-gmail__create_draft` | Create draft (does NOT auto-send) |

## Workflow

See `workflows/process-emails.md`
