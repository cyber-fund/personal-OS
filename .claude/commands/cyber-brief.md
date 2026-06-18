---
name: cyber-brief
description: Generate morning brief with Telegram, email, calendar, and Twitter context
---

Morning brief combining all communication channels for the day.

## Usage

```
/cyber-brief                       # Full morning brief
/cyber-brief --days 3              # Calendar lookahead (default 2)
```

## Workflow

Full workflow: `.claude/skills/cyber-brief/workflows/morning-brief.md`

### Phase 1: Data Gathering (parallel where possible)

1. **Telegram** — Call `mcp__cybos-telegram__read_unread` with `summary_only: true`
2. **Email** — Call `mcp__cybos-gmail__search_emails` with `is:unread OR is:important`
3. **Calendar** — Call `mcp__cybos-gmail__list_calendar_events` with `days: 2`
4. **Twitter** — Call `mcp__cybos-twitter__read_feed_summary`
5. **Identity** — Read `~/personal-OS-vault/private/context/identity.md` for context

### Phase 2: Brief Generation

List all items per channel without filtering or ranking:
1. **Calendar** — Today's and tomorrow's meetings
2. **Telegram** — All unread dialogs with message counts
3. **Email** — All unread/important emails
4. **Twitter** — Latest posts from tracked accounts

### Phase 3: Output

Save to `~/personal-OS-vault/private/workspace/briefs/MMDD-YY.md`

## MCP Tools (Local Connectors)

- `mcp__cybos-telegram__read_unread`
- `mcp__cybos-twitter__read_feed_summary`
- `mcp__cybos-gmail__search_emails`
- `mcp__cybos-gmail__list_calendar_events`
