# Twitter Post Creation Workflow

## MCP Tools

- `mcp__cybos-twitter__sync_feed` — fetch latest timeline + own posts
- `mcp__cybos-twitter__read_my_posts` — read own posts with metrics
- `mcp__cybos-twitter__sync_my_posts` — fetch own tweets from profile with fresh metrics (no feed cooldown)
- `mcp__typefully__typefully_list_social_sets` — get social set ID
- `mcp__typefully__typefully_list_social_set_analytics_posts` — get updated engagement metrics
- `mcp__typefully__typefully_create_draft` — create/schedule post
- `mcp__typefully__typefully_list_drafts` — check existing drafts

## Steps

### 1. GATHER CONTEXT

Run these in parallel where possible:

**a) Sync feed** (if not synced recently):
Call `mcp__cybos-twitter__sync_feed` to get latest timeline data.

**b) Read own posts**:
Call `mcp__cybos-twitter__read_my_posts` to get recent posts with metrics.

**c) Refresh engagement from Typefully**:
Call `mcp__typefully__typefully_list_social_sets` to get the social_set_id.
Then call `mcp__typefully__typefully_list_social_set_analytics_posts` with:
- platform: "x"
- start_date: 7 days ago (YYYY-MM-DD)
- end_date: today (YYYY-MM-DD)
- limit: 50

**d) Read feed context**:
Read 3-5 most recently updated files from `vault/private/context/twitter/` to understand what's trending in the feed.

**e) Read private context** (the user's real life — use for topic inspiration):
- `vault/private/context/telegram/` — scan recent chat files (read 3-5 most recent) for topics, discussions, insights
- `vault/private/context/emails/` — scan recent emails for themes
- `vault/private/context/calls/` — scan recent call notes for insights
- `vault/private/projects/` — scan active project READMEs/status files for things worth sharing
- `vault/private/context/who-am-i.md` — priorities and role context

Extract interesting themes: technical insights, investment observations, project milestones, conversations that sparked ideas. Do NOT include confidential details, names, or deal terms — extract only the generalized insight or pattern.

**f) Load style context**:
Read `vault/private/context/style/voice-identity.md` for tone of voice.
Read `vault/private/context/twitter/posting-prompt.md` for the self-improving prompt (create from default if missing).

### 2. ANALYZE ENGAGEMENT

From Typefully analytics data:
- Identify top 3 posts by impressions
- Identify bottom 3 posts by impressions
- Calculate average engagement rate (likes/impressions)
- Note patterns: what topics, formats, hooks, lengths work best

Present a brief engagement summary to the user:
```
Recent performance (last 7 days):
- X posts published
- Best: "..." (Y views, Z likes)
- Avg engagement rate: N%
- Pattern: [what's working]
```

### 3. UPDATE SELF-IMPROVING PROMPT

Read `vault/private/context/twitter/posting-prompt.md`.

If new engagement data reveals actionable patterns, append to the `## Learnings` section:
- Date of analysis
- What worked (topics, hooks, format)
- What didn't work
- Specific adjustment for next post

Rules for prompt updates:
- Only add genuinely new insights (don't repeat existing learnings)
- Keep learnings section under 20 items (trim oldest if needed)
- Never remove the base prompt, only evolve the learnings

### 4. PROPOSE 5 TOPICS

Based on ALL gathered context (feed trends, private context, engagement patterns, self-improving prompt), propose exactly 5 topic ideas.

For each topic, present:
```
1. [Topic title] (tweet | thread)
   Source: [what inspired it — e.g., "conversation about X", "feed trend on Y", "project milestone"]
   Hook: [draft opening line]
   Why: [why this should perform well based on engagement data]
```

Rules for topic selection:
- Mix sources: at least 1 from private context (chats/emails/projects), at least 1 from feed trends
- Prioritize topics where you have a unique angle others don't
- Favor formats that have performed well recently (per engagement data)
- Never expose confidential info — generalize private context into public-safe insights
- If the user provided a specific topic/direction in the command, include it as topic #1

Ask the user to pick a number (1-5) or describe a different direction.

### 5. GENERATE DRAFT

Once the user picks a topic, generate the draft using:
- The self-improving prompt + voice identity
- Feed context for relevance
- Private context for depth (generalized, no confidential details)

Rules:
- Follow voice-identity.md strictly (anti-patterns, formatting)
- Lead with insight, not context
- Each tweet in a thread must stand alone
- Use numbers and specifics over vague claims
- No hashtags unless genuinely relevant
- Thread delimiter: use `\n\n\n\n` (4 newlines) between tweets for Typefully

Present the draft clearly formatted.

### 6. USER REVIEW

Ask the user:
- **Accept** — proceed to schedule
- **Edit** — user provides feedback, regenerate
- **Reject** — go back to topic selection or abort

Do NOT proceed without explicit approval. Iterate on edits until the user is satisfied.

### 7. SCHEDULE VIA TYPEFULLY

Once approved, ask timing preference:
- **Draft** — save as draft in Typefully
- **Now** — publish immediately
- **Queue** — add to next free slot
- **Scheduled** — specific date/time

Call `mcp__typefully__typefully_create_draft` with:
- social_set_id from step 1c
- content (with thread delimiters if thread)
- platform config: x enabled
- schedule setting based on user choice

### 8. ARCHIVE

Save the post to `vault/content/posts/MMDD-<slug>-YY.md` with:
```markdown
---
date: YYYY-MM-DD
platform: twitter
format: tweet|thread
status: scheduled|published|draft
typefully_id: <if available>
topic: <selected topic title>
source: <what inspired it>
---

<content>
```

### 9. CONFIRM

Display:
- Post content (abbreviated if thread)
- Schedule time
- Typefully status
- Reminder: "Engagement will be tracked on next /cyber-twitter run"
