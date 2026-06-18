---
name: cyber-save-calls
description: Extract Granola meeting transcripts and save to vault
---

Extract new meeting transcripts from Granola and save to vault.

## Usage

```
/cyber-save-calls                  # Incremental sync (new calls only)
```

## Workflow

1. Call `mcp__cybos-granola__list_saved_calls` to get IDs already in vault
2. Call `mcp__cybos-granola__list_meetings` to get recent meetings
3. Diff the two lists to find new meetings
4. For each new meeting:
   a. Call `mcp__cybos-granola__get_meeting` with the note ID to get summary, attendees, and transcript
   b. Call `mcp__cybos-granola__save_call` with the collected data to persist to vault
5. Report: N new calls saved, total calls in vault
6. Log activity

## MCP Tools (Local Connector)

- `mcp__cybos-granola__list_meetings` — list recent meetings from Granola API
- `mcp__cybos-granola__get_meeting` — get meeting details with summary and transcript
- `mcp__cybos-granola__save_call` — save meeting data to vault
- `mcp__cybos-granola__list_saved_calls` — list already-saved meeting IDs

## Output

Call transcripts: `~/personal-OS-vault/private/context/calls/YYYY-MM-DD_<title-slug>/`
