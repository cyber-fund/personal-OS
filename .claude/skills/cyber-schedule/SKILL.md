---
name: cyber-schedule
description: Schedule content to Twitter and/or LinkedIn via Typefully. Text only (no image generation).
---

# cyber-schedule Skill

Schedule social media posts via Typefully following voice/style guidelines.

## Architecture

```
COMMAND (cyber-schedule)
    |
    v
WORKFLOW (schedule.md)
    |
    +-> LOADS: ~/personal-OS-vault/private/context/style/voice-identity.md
```

## Context Files (in vault, not repo)

| File | Purpose |
|------|---------|
| `~/personal-OS-vault/private/context/style/voice-identity.md` | Persona, tone, style rules, anti-patterns |

These files are created during setup with defaults and customized by the user.

## Workflow

| Workflow | Output |
|----------|--------|
| `workflows/schedule.md` | Scheduled social posts via Typefully |

## Output

Posts saved to `~/personal-OS-vault/private/content/posts/MMDD-<slug>-YY.md`

## Key Rules

1. Commands call workflows — no embedded style in commands
2. Workflows load context from vault — voice-identity.md
3. Single source of truth — all style rules live in vault context files
