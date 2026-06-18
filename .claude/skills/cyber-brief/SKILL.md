---
name: cyber-brief
description: Generate morning brief with Telegram, email, calendar, and Twitter context.
---

# cyber-brief Skill

Morning brief combining all communication channels into a single overview for the day.

## Data Sources

| Source | MCP/Method |
|--------|------------|
| Telegram | `mcp__cybos-telegram__read_unread` (summary_only) |
| Email | `mcp__cybos-gmail__search_emails` |
| Calendar | `mcp__cybos-gmail__list_calendar_events` |
| Twitter | `mcp__cybos-twitter__read_feed_summary` |
| Identity | Read vault file `private/context/identity.md` |

## Workflow

See `workflows/morning-brief.md`
