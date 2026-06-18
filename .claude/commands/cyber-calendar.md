---
name: cyber-calendar
description: Query Google Calendar for upcoming meetings
---

Display upcoming calendar events in a structured format.

## Usage

```
/cyber-calendar                    # Next 2 days (default)
/cyber-calendar --days 7           # Next 7 days
```

## Workflow

1. Call `mcp__cybos-gmail__list_calendar_events` with `days` parameter
2. Format as markdown tables grouped by day
3. Include: time, event title, attendees, location/link
4. Display inline (no file persistence — ephemeral output)

## MCP Tools (Local Connector)

- `mcp__cybos-gmail__list_calendar_events`
