# Email Processing Workflow

## Mode: Default (Draft Replies)

### 1. FETCH UNREAD EMAILS

Call `mcp__cybos-gmail__search_emails` with query `is:unread`.
If `--from` specified, add `from:<email>` to query.
If `--count` specified, limit results.

### 2. READ FULL CONTENT

For each email, call `mcp__cybos-gmail__read_email` with message_id.

### 3. GENERATE DRAFT REPLIES

For each email that needs a reply:
- Match the tone of the original email
- Reference specific points from the email
- Keep replies concise and professional
- Load identity context if available for personalization

### 4. PRESENT FOR APPROVAL

Show each draft with the original email context. Ask user to approve/edit/skip.

### 5. SAVE DRAFTS

For approved drafts, call `mcp__cybos-gmail__create_draft` which creates a Gmail draft (does NOT auto-send).

### 6. LOG

Append activity to session log.

## Mode: Sync (--sync)

### 1. SEARCH RECENT EMAILS

Call `mcp__cybos-gmail__search_emails` with query `newer_than:7d` (or `newer_than:Nd` if `--days N`).

### 2. LOAD SYNC STATE

Read `~/personal-OS-vault/private/context/emails/.sync-state.json`.
This file tracks:
```json
{
  "lastSync": "2026-04-19T10:00:00Z",
  "syncedIds": ["msg_id_1", "msg_id_2", ...]
}
```

If file doesn't exist, treat all emails as new.

### 3. FILTER ALREADY SYNCED

Compare fetched email IDs against `syncedIds`. Skip any already synced.

### 4. READ AND SAVE NEW EMAILS

For each new email:
1. Call `mcp__cybos-gmail__read_email` with message_id
2. Create file at `~/personal-OS-vault/private/context/emails/YYYY-MM-DD_<slug>.md`
   - `<slug>` = sanitized subject (lowercase, hyphens, max 50 chars)
   - If file exists, append numeric suffix

File format:
```markdown
---
date: YYYY-MM-DD
type: email
from: sender@example.com
to: recipient@example.com
subject: Original subject line
message_id: <gmail_message_id>
synced_at: YYYY-MM-DDTHH:MM:SSZ
---

# <Subject>

From: sender@example.com
Date: YYYY-MM-DD HH:MM

<email body>
```

### 5. UPDATE SYNC STATE

Add new message IDs to `syncedIds` array.
Update `lastSync` timestamp.
Write back to `.sync-state.json`.

Keep only last 500 IDs in `syncedIds` to prevent file bloat.

### 6. REPORT

Print summary: "Synced N new emails (M skipped, already in vault)"

## Safety

- NEVER auto-send emails
- Always create drafts for user review
- User sends manually from Gmail
