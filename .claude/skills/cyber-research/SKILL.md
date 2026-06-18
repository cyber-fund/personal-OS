---
description: Company due diligence, technology deep-dives, market analysis, and topic exploration for investment decisions, content creation, and personal projects. Supports 3 intensity levels (quick/standard/deep) for speed-quality tradeoffs.
---

# Research Skill

Company due diligence, technology deep-dives, market analysis, and topic exploration for investment decisions, content creation, and personal projects.

## Capabilities

- **Company Research**: Comprehensive DD on target companies
- **Technology Research**: Deep technical analysis of technologies
- **Market Research**: Market sizing, dynamics, and opportunity assessment
- **Topic Research (Content)**: Ideas, narratives, people for essays/tweets
- **Topic Research (Investment)**: Market dynamics and opportunities for investment thesis

## Research Intensity Levels

- **🔍 Quick** (10-30s): 1 agent
- **🔬 Standard** (2-5m): 2-3 agents [DEFAULT]
- **🔎 Deep** (5-15m): 3-5 agents + quality-reviewer

## Workflow

All research types use **one universal workflow**:
- `workflows/orchestrator.md`

The orchestrator dynamically selects agents based on research type and intensity.

## Output Locations

All paths are relative to the workspace root (the folder the user opened in Cowork).

**When a project folder exists** for the subject (e.g. `./private/projects/<company>/`), write into the project:

```
./private/projects/<company>/context/research/MMDD-<slug>-YY/
├── raw/         # Agent outputs
└── report.md    # Final synthesis
```

**Otherwise**, write to the shared content folder:

```
./content/research/MMDD-<slug>-YY/
├── raw/
└── report.md
```

If the work belongs to a multi-session effort, scaffold a project first with `/cyber-create-project` and re-run.

## Key Principles

1. **Agents do ALL data gathering** - Main session orchestrates, agents make MCP calls
2. **No redundancy** - Each agent makes its own calls autonomously
3. **Dynamic selection** - Agents chosen based on research type + intensity
4. **Quality loop** - Deep mode includes quality-reviewer (max 1 iteration)

## Investment Context

All research applies a venture investment philosophy:
- Path to $1B+ revenue (not niche $50M ARR outcomes)
- Defensible moat (data, network effects, hard tech)
- Clear business model (revenue > token speculation)
- Strong founders (high energy, sales DNA, deep expertise)
- Market timing ("why now?")
