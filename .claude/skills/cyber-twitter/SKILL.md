---
name: cyber-twitter
description: Analyze feed trends and own post performance, generate tweet/thread drafts, push to Typefully. Self-improving prompt adjusts based on engagement data.
---

# cyber-twitter Skill

Generate high-performing Twitter content by analyzing feed context and own post engagement.

## Architecture

```
COMMAND (cyber-twitter)
    |
    v
WORKFLOW (create-post.md)
    |
    +-> READS: vault/private/context/twitter/*.md (feed context)
    +-> READS: vault/private/context/twitter/my-posts.md (own posts + metrics)
    +-> READS: vault/private/context/twitter/posting-prompt.md (self-improving prompt)
    +-> READS: vault/private/context/style/voice-identity.md (tone of voice)
    +-> READS: vault/private/context/telegram/*.md (recent chats)
    +-> READS: vault/private/context/emails/*.md (recent emails)
    +-> READS: vault/private/context/calls/*.md (call notes)
    +-> READS: vault/private/projects/*/status.md (active projects)
    +-> USES:  Typefully analytics API (updated engagement data)
    +-> USES:  Typefully create_draft (publish)
    +-> WRITES: vault/private/context/twitter/posting-prompt.md (prompt evolution)
    +-> WRITES: vault/content/posts/MMDD-<slug>-YY.md (post archive)
```

## Context Files (in vault)

| File | Purpose |
|------|---------|
| `private/context/twitter/my-posts.md` | Own tweets with engagement metrics |
| `private/context/twitter/posting-prompt.md` | Self-improving generation prompt |
| `private/context/style/voice-identity.md` | Persona, tone, anti-patterns |
| `private/context/twitter/*.md` | Feed context from followed accounts |
| `private/context/telegram/*.md` | Recent chats for topic inspiration |
| `private/context/emails/*.md` | Email threads for themes |
| `private/context/calls/*.md` | Call notes for insights |
| `private/projects/*/status.md` | Active project context |

## Workflow

| Workflow | Output |
|----------|--------|
| `workflows/create-post.md` | Tweet/thread draft -> Typefully |

## Flow

1. Gather context: feed + private (chats, emails, calls, projects) + engagement data
2. Analyze engagement + update self-improving prompt
3. Propose 5 topics (mix of feed-inspired and private-context-inspired)
4. User picks a topic
5. Generate draft in user's voice
6. User reviews (accept / edit / reject)
7. Push to Typefully with chosen timing
8. Archive to vault

## Self-Improvement Loop

1. Fetch updated engagement via Typefully analytics API for posts from last 7 days
2. Identify top/bottom performers by impressions and likes
3. Extract patterns (topics, format, length, hooks)
4. Update `posting-prompt.md` with new learnings
5. Use updated prompt for next generation

## Key Rules

1. Always show draft to user before publishing
2. Never publish without explicit approval
3. Prompt updates are appended as learnings, not full rewrites
4. Each post is archived in vault for future analysis
5. Private context is used for inspiration only — never expose confidential details, names, or deal terms in tweets
