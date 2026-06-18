---
name: cyber-setup
description: Initialize workspace structure, seed context, capture who-am-i + tone-of-voice
---

Bootstrap the workspace inside the vault symlink (`./vault/`). Create folder structure, seed baseline context files, and run a chat-based interview to capture identity and writing style.

**All files are created inside `./vault/`** (symlink to the user's vault path, created by the setup wizard).

## Usage

```
/cyber-setup                       # Full setup (idempotent)
/cyber-setup --force               # Re-run interviews and refresh files
```

## Workflow

Full workflow: `.claude/skills/cyber-setup/SKILL.md`

### Phase 0: Check if already set up
- Look for markers in `./vault/`: CLAUDE.md, GTD.md, content/, private/projects/, private/context/
- If all exist and no --force: report and exit
- If some missing: only create what's missing

### Phase 1: Create directory structure
```
./vault/
├── CLAUDE.md
├── GTD.md
├── content/{briefs,research,memos,drafts}/
├── private/
│   ├── context/{cyber.md,who-am-i.md,calls/,emails/,telegram/,style/}
│   └── projects/
└── shared/
```

### Phase 2: Write CLAUDE.md
From `artifacts/CLAUDE.md` template → `./vault/CLAUDE.md`

### Phase 3: Seed cyber.md
From `artifacts/cyber.md` → `./vault/private/context/cyber.md`

### Phase 4: Seed GTD.md
From `artifacts/GTD.md` → `./vault/GTD.md`

### Phase 5: Who-Am-I interview (chat)
Ask user for name, role, org, priorities, handles, notes.
Fill `artifacts/who-am-i.md` template → `./vault/private/context/who-am-i.md`

### Phase 6: Tone-of-Voice interview (chat)
Collect writing samples and style preferences.
Analyze and generate → `./vault/private/context/style/tone-of-voice.md`

### Phase 7: Connectors checklist
Show available connectors (Gmail, Calendar, Telegram, Granola, etc.)

### Phase 8: Final report
Show structure summary and next steps.

## Artifacts

Templates in `.claude/skills/cyber-setup/artifacts/`:
- `CLAUDE.md` — workspace operating manual
- `cyber.md` — org context
- `who-am-i.md` — identity template with {{placeholders}}
- `GTD.md` — task list skeleton
