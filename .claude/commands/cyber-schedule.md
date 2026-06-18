---
name: cyber-schedule
description: Schedule content to Twitter and/or LinkedIn via Typefully
---

Schedule or publish content to social media.

## Usage

```
/cyber-schedule @path/to/content.md           # From file
/cyber-schedule "Raw text content here"       # Raw text
/cyber-schedule @content.md --account myhandle  # Specific account
```

## Workflow

Full workflow: `.claude/skills/cyber-schedule/workflows/schedule.md`

1. Read content (file or raw text)
2. Ask user to select social set (account) via `mcp__claude_ai_Typefully__list_social_sets`
3. Ask platform: Twitter / LinkedIn / Both
4. Ask timing: Draft / Now / Queue / Scheduled
5. Call `mcp__claude_ai_Typefully__create_draft` with platform config
6. Confirm with private URL link
7. Log activity

## MCP Tools (Claude.ai Built-in)

- `mcp__claude_ai_Typefully__get_me`
- `mcp__claude_ai_Typefully__list_social_sets`
- `mcp__claude_ai_Typefully__create_draft`

If Typefully MCP is not connected, guide user: "Run `/mcp` and connect Typefully"
