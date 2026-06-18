---
name: cyber-email
description: Process Gmail messages - read, draft replies, sync to vault
---

Process emails: sync to vault and/or draft replies (never auto-send).

## Usage

```
/cyber-email                       # Process unread emails, draft replies
/cyber-email --sync                # Sync last 7 days of emails to vault (skip already synced)
/cyber-email --sync --days 14      # Sync last 14 days
/cyber-email --count 5             # Process 5 unread emails
/cyber-email --from "john@x.com"   # Filter by sender
```

## Modes

### Default mode (no --sync): Draft replies
1. Call `mcp__cybos-gmail__search_emails` with query `is:unread`
2. For each email, read full content via `mcp__cybos-gmail__read_email`
3. Generate contextual draft replies
4. Present drafts for user approval
5. For approved drafts: create Gmail draft via `mcp__cybos-gmail__create_draft` (creates draft, does NOT auto-send)
6. Log activity

### Sync mode (--sync): Save emails to vault
1. Call `mcp__cybos-gmail__search_emails` with query `newer_than:7d` (or `--days N`)
2. Load existing synced email IDs from `~/personal-OS-vault/private/context/emails/.sync-state.json`
3. Skip emails whose message_id is already in the sync state
4. For each new email, call `mcp__cybos-gmail__read_email`
5. Save each email as `~/personal-OS-vault/private/context/emails/YYYY-MM-DD_<slug>.md` with frontmatter:
   ```
   ---
   date: YYYY-MM-DD
   type: email
   from: sender@example.com
   subject: Email subject
   message_id: <gmail_message_id>
   ---
   ```
6. Update `.sync-state.json` with new message IDs and `lastSync` timestamp
7. Report: "Synced N new emails (M already in vault)"

## MCP Tools (Local Connector)

- `mcp__cybos-gmail__search_emails`
- `mcp__cybos-gmail__read_email`
- `mcp__cybos-gmail__create_draft`

## Output

- Sync: `~/personal-OS-vault/private/context/emails/<date>_<slug>.md`
- Drafts: `~/personal-OS-vault/private/content/work/MMDD-email-replies-YY.md`
