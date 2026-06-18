---
name: cyber-research
description: Company DD, technology deep-dives, market analysis with configurable intensity
---

Research skill for company due diligence, technology deep-dives, market analysis, and topic exploration.

## Usage

```
/cyber-research "Company Name"                 # Company DD (standard)
/cyber-research "AI Agents" --deep             # Deep research
/cyber-research "Robotics market" --quick      # Quick overview
```

## Research Types

| Type | Trigger |
|------|---------|
| Company DD | Company name |
| Technology | Tech topic |
| Market | Market/sector |
| Topic (Content) | Content angle |
| Topic (Investment) | Investment angle |

## Intensity Levels

| Level | Duration | Agents | Use Case |
|-------|----------|--------|----------|
| Quick | 10-30s | 1 | Fast fact-check |
| **Standard** | 2-5m | 2-3 | Normal research (DEFAULT) |
| Deep | 5-15m | 3-5 + reviewer | Memo-ready, comprehensive |

## Workflow

Full workflow: `.claude/skills/cyber-research/workflows/orchestrator.md`

1. **INITIALIZE** — Identify type, intensity, create workspace
2. **GATHER** — Spawn agents in parallel (autonomous MCP usage)
3. **REVIEW** — Quality check (deep mode only, max 1 iteration)
4. **SYNTHESIZE** — Consolidate into unified report
5. **OUTPUT** — Save report + update project context
6. **LOG** — Record completion

## Output

When project folder exists:
```
./vault/private/projects/<company>/context/research/MMDD-<slug>-YY/report.md
```

Otherwise:
```
./vault/content/research/MMDD-<slug>-YY/report.md
```
