# Morning Brief Workflow

## Phase 1: Data Gathering

Gather data from all sources in parallel where possible:

1. **Telegram** — Call `mcp__cybos-telegram__read_unread` with `summary_only: true`
   - Get unread dialog count, names, message counts
2. **Email** — Call `mcp__cybos-gmail__search_emails` with `is:unread OR is:important`
   - Get subject, sender, date for recent emails
3. **Calendar** — Call `mcp__cybos-gmail__list_calendar_events` with `days: 2`
   - Get today's and tomorrow's meetings
4. **Twitter** — Call `mcp__cybos-twitter__read_feed_summary`
   - Already synced at session start
5. **Identity** — Read `~/personal-OS-vault/private/context/identity.md`
   - Load user context for tone/framing

## Phase 2: Brief Generation

List everything for the day without filtering or scoring. Show all items in each channel.

```markdown
# Morning Brief — YYYY-MM-DD

## Calendar
| Time | Event | Attendees |
|------|-------|-----------|
| 10:00 | Sync with John | John Doe |
| 14:00 | Team standup | Team |

## Telegram (N unread)
- **John Doe** (3 messages): Asking about term sheet
- **Jane** (1 message): Quick question about demo
- **Acme Group** (5 messages): Discussion about roadmap

## Email (N unread)
- **investor@fund.com**: Q1 report follow-up
- **founder@startup.com**: Updated deck attached
- **noreply@service.com**: Weekly digest

## Twitter Highlights
- Latest posts from tracked accounts
```

## Phase 3: Output

Save to `~/personal-OS-vault/private/workspace/briefs/MMDD-YY.md`
Display the brief to the user.
