---
name: cyber-create-project
description: Scaffold a new project folder under ./vault/private/projects/ with CLAUDE.md, README, status, and decisions log
---

Create a self-contained project directory under `./vault/private/projects/<slug>/` with its own operating manual so multi-session work has a dedicated home.

## Usage

```
/cyber-create-project "Project Name"    # Create with given name
/cyber-create-project                   # Ask for name first
```

## Workflow

Full workflow: `.claude/skills/cyber-create-project/SKILL.md`

### Phase 0: Get name
If no name passed, ask the user.

### Phase 1: Slugify
Convert to URL-safe slug: lowercase, hyphens, no special chars.

### Phase 2: Check for conflict
If `./vault/private/projects/<slug>/` exists, report it. Don't overwrite.

### Phase 3: Create structure
```
./vault/private/projects/<slug>/
├── CLAUDE.md          # project-scoped operating manual
├── README.md          # overview
├── status.md          # current state
├── decisions.md       # rationale log
├── context/           # research, notes, references
└── deliverables/      # generated outputs
```

Templates in `.claude/skills/cyber-create-project/artifacts/`. Substitute `{{name}}`, `{{slug}}`, `{{date}}`.

### Phase 4: Link from GTD.md
Append to `./vault/GTD.md` under `# Now` section.

### Phase 5: Report
Show structure and next steps.

## Artifacts

Templates in `.claude/skills/cyber-create-project/artifacts/`:
- `CLAUDE.md` — project operating manual
- `README.md` — project overview
- `status.md` — current state tracker
- `decisions.md` — rationale log
