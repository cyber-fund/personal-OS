---
description: Initialize the workspace directory structure, seed organization context, capture who-am-i + tone-of-voice through a chat-based interview, and create the living GTD.md.
---

# Setup Skill

Bootstrap a personal-OS workspace: create the folder structure, seed baseline context files (`cyber.md`, `GTD.md`), and run a chat-based interview that captures who the user is (`who-am-i.md`) and how they write (`tone-of-voice.md`).

**Usage:**
- `/cyber-setup` — run full setup (idempotent; only creates what's missing)
- `/cyber-setup --force` — re-run interviews and refresh `CLAUDE.md` even if already set up

---

## Workflow

The workspace root is the **vault symlink** at `./vault/` in the repo root (created by the setup wizard, points to the user's vault path e.g. `~/personal-OS-vault`). All paths below are relative to `./vault/`.

> **Interactive phases rule:** All user input MUST be collected through the chat conversation. NEVER render custom input fields, forms, text areas, or any visual UI components. Instead, ask questions in chat and wait for the user to reply. Each question or group of questions is a blocking step — the skill pauses there until the user responds in chat.

### Phase 0: CHECK IF ALREADY SET UP

Inspect `./vault/` for the expected markers:

1. `./vault/CLAUDE.md`
2. `./vault/GTD.md`
3. `./vault/content/`
4. `./vault/private/projects/`
5. `./vault/private/context/cyber.md`
6. `./vault/private/context/who-am-i.md`
7. `./vault/private/context/style/tone-of-voice.md`

**If ALL markers exist and `--force` was not passed:**
- Output: "Workspace already set up."
- Show the structure briefly so the user can verify.
- Ask if they want to re-run the who-am-i / tone-of-voice interviews.
- If they decline, exit.

**If SOME markers exist:** report which are present/missing, only create the missing parts, and run interviews for any missing profile files.

**If NONE exist:** proceed with full setup.

---

### Phase 1: CREATE DIRECTORY STRUCTURE

Create the following folder tree. Use `mkdir -p`; never overwrite.

```
./vault/
├── CLAUDE.md                  # Phase 2
├── GTD.md                     # Phase 4
├── content/
│   ├── briefs/
│   ├── research/
│   ├── drafts/
│   └── summaries/
├── private/
│   ├── context/
│   │   ├── cyber.md           # Phase 3
│   │   ├── who-am-i.md        # Phase 5
│   │   ├── calls/
│   │   ├── emails/
│   │   ├── telegram/
│   │   └── style/
│   │       └── tone-of-voice.md   # Phase 6
│   └── projects/
└── shared/
```

**Legacy handling:** if an old `./vault/private/workspace/` directory exists (from a previous setup version), leave it in place and surface a one-line note: `Legacy './vault/private/workspace/' preserved. New work belongs under './vault/private/projects/'.` Do not auto-migrate contents.

After creation, output the tree so the user can see what was built.

---

### Phase 2: WRITE CLAUDE.md

Read the template from `artifacts/CLAUDE.md` (relative to this skill) and write it to `./vault/CLAUDE.md`.

- If `./vault/CLAUDE.md` does **not** exist: create it.
- If it **does** exist and `--force` was passed: overwrite.
- If it exists and `--force` was not passed: skip and note "CLAUDE.md already present (use --force to refresh)".

This file is the vault operating manual — it tells Claude where context and projects are stored. The template is generic; no per-user substitution is required.

---

### Phase 3: SEED cyber.md

Read `artifacts/cyber.md` (the organization-context template) and write it to `./vault/private/context/cyber.md`, substituting `{{ORGANIZATION}}` with the org name captured in the interview.

- The template ships with placeholders. Fill in what's known from the interview; leave the rest for the user to complete later.
- Only create if missing. Do not overwrite in non-force mode.

---

### Phase 4: SEED GTD.md

Read `artifacts/GTD.md` (the skeleton) and write it to `./vault/GTD.md`.

- Only create if missing.
- The skeleton has sections `# Now / # Next / # Waiting / # Someday / # Done`. Do not pre-populate items.

---

### Phase 5: WHO-AM-I INTERVIEW (chat)

Collect the following information through a **chat conversation**. NEVER render custom input fields, forms, or visual UI components. Instead, list the questions in chat and ask the user to reply with their answers.

Collect:

| Field | Required |
|-------|----------|
| Name | yes |
| Role | yes |
| Organization | yes |
| Top priority 1 | yes |
| Top priority 2 | yes |
| Top priority 3 | no |
| Email | no |
| Telegram handle | no |
| Twitter handle | no |
| LinkedIn handle | no |
| Notes for Claude | no |

Present all the questions at once in a numbered list so the user can answer them in a single reply. Mark which fields are required vs optional.

**CRITICAL — STOP AND WAIT:** After presenting the questions, you MUST stop and wait for the user to reply in chat with their answers. Do NOT proceed with empty or default values. If the user's reply is missing required fields, ask them to provide the missing required fields before continuing. Only once you have received the user's actual answers in chat should you move to the next step.

Read `artifacts/who-am-i.md`, substitute the `{{placeholders}}` with the user's answers (empty placeholders become "—"), and write to `./vault/private/context/who-am-i.md`.

Show the final file back to the user in chat and confirm before saving.

---

### Phase 6: TONE-OF-VOICE INTERVIEW (chat)

Collect all tone-of-voice information through a **chat conversation**. NEVER render custom input fields, forms, or visual UI components.

**Questions to ask in chat:**

1. **Samples source**: Ask the user how they'd like to provide writing samples — paste directly in chat, provide file paths, share Google Drive links, or just describe their style.
2. **Samples input**: Based on their answer to #1, ask them to share the samples or description in chat.
3. **Dimension tags**: Ask the user to pick from options for each dimension: formality (formal / semi-formal / casual / very casual), sentence length (short / mixed / long), vocabulary (simple / technical / domain-specific), tone (direct / diplomatic / warm / analytical / humorous), punctuation habits (heavy / minimal / emoji / ellipsis), emoji usage (none / occasional / frequent).
4. **Characteristic openings / closings / phrases**: Ask the user to share any characteristic phrases, openings, or closings they commonly use.
5. **Style rules**: Ask if they have any specific style rules or preferences.

Present all questions at once so the user can answer in one or a few replies.

**CRITICAL — STOP AND WAIT:** After presenting the questions, you MUST stop and wait for the user to reply in chat. Do NOT proceed with empty or default values. The user needs time to gather samples and think about their style. Only once you have received the user's actual answers in chat should you move to the analysis step below.

**Analysis:** once the user submits, analyze the samples for:

- Formality level (formal / semi-formal / casual / very casual)
- Sentence structure (short / mixed / long)
- Vocabulary (simple / technical / domain-specific)
- Tone (direct / diplomatic / warm / analytical / humorous)
- Punctuation habits (heavy / minimal / emoji / ellipsis)
- Opening / closing patterns
- Filler phrases, verbal tics, language mixing
- Formatting preferences

**Preview:** show the draft profile in chat. Ask the user if anything needs adjusting. Iterate until the user confirms.

**Save to:** `./vault/private/context/style/tone-of-voice.md`, using the same template format as before (Summary, Characteristics table, Patterns, Style Rules, Sample Fingerprints).

Phases 5 and 6 can be merged into a single chat conversation so the user answers everything in one flow. Even when merged, the skill MUST wait for the user to reply with their answers before processing — never auto-advance past unanswered questions.

---

### Phase 7: REPO-ROOT CLAUDE.md

Write a `CLAUDE.md` file to the **personal-OS repo root** (not the vault). This file explains to Claude how the repo relates to the vault:

```markdown
# personal-OS

Personal AI workspace powered by Claude Code.

## Vault

The `./vault/` symlink points to the user's data vault. All personal data, context, and project files live there.

- `./vault/CLAUDE.md` — vault-level operating manual (where context + projects live)
- `./vault/GTD.md` — living to-do list
- `./vault/private/context/` — identity, org context, tone-of-voice, synced source data
- `./vault/private/projects/` — multi-session project directories
- `./vault/content/` — generated artifacts (briefs, research, drafts, summaries)

## Skills

Skills live in `.claude/skills/`. Run them with `/skill-name` in Claude Code.

## Connectors

Custom connectors in `connectors/` provide Telegram, Twitter, Google Workspace (Gmail,
Calendar, Docs, Sheets, Slides), Granola, Asana, and Slack integrations.
Secrets are stored in macOS Keychain, never in plaintext.
```

- Only create if missing. Do not overwrite unless `--force`.

---

### Phase 7.5: CONNECTOR CHOICES (chat)

Connectors are enabled/credentialed in the web setup wizard, but two of them need an
explicit choice — surface these in chat during setup (and whenever the user enables the
connector later):

**Granola — pick a mode:**
- **API mode** (recommended if they have a *paid* Granola plan): store `GRANOLA_API_KEY` in
  Keychain (`cybos.granola`). Stable, official API.
- **Scrape mode** (no paid plan): reads Granola's local cache on disk — no key needed. ⚠ Warn
  the user this is **unstable**: it depends on Granola's internal, undocumented file format and
  **may break on a Granola update and require a fix**. Persist the choice as
  `custom_connectors.granola.mode` (`"api"` | `"scrape"`) in `~/.cyboslite/connectors.json`.
  If unset, the connector infers: API key present → api, otherwise scrape.

**Google Workspace — scope re-auth:**
- The connector now covers Gmail, Calendar (read **and** event create), and read-only Docs,
  Sheets, Slides. These need broadened OAuth scopes. If the user already connected Gmail under
  the old (narrower) scopes, they must **re-run the OAuth flow** so the new refresh token carries
  Docs/Sheets/Slides + `calendar.events`. Event creation is a write — the agent must confirm
  details with the user before calling `create_calendar_event` (no invites are emailed).

**Slack:** needs a bot token (`SLACK_BOT_TOKEN`, `xoxb-…`) in Keychain (`cybos.slack`) for
reading channels/threads and posting. `search_messages` additionally needs a user token
(`SLACK_USER_TOKEN`, `xoxp-…`). Posting is a write — confirm text + destination first.

---

### Phase 8: FINAL REPORT

```
Setup complete!

Structure:
  CLAUDE.md (repo root + vault)
  GTD.md
  content/{briefs,research,drafts,summaries}/
  private/context/cyber.md
  private/context/who-am-i.md
  private/context/style/tone-of-voice.md
  private/context/{calls,emails,telegram}/
  private/projects/
  shared/

Next steps:
  1. /cyber-create-project "Your first project"
  2. /cyber-brief to generate today's situational brief
```

---

## Error Handling

| Error | Response |
|-------|----------|
| No write permissions in current directory | Ask user to fix permissions or open a different folder in Cowork |
| User provides no writing samples | Generate a minimal profile from their dimension-tag answers; note low confidence |
| User provides very short samples (<50 words total) | Warn that the profile will be rough; ask for more |
| User cancels the interview mid-way | Save what was collected; note which files are still pending |
| Profile generation feels inaccurate to user | Iterate — ask what's wrong, adjust, re-save |

---

## Notes

- Setup is idempotent. Safe to run multiple times; only creates what's missing.
- Use `--force` when the repo's artifact templates evolve and you want to refresh `CLAUDE.md` / re-run interviews.
- `cyber.md` is pre-seeded and identical for every user — no interview for it.
- All generated artifacts (briefs, research, drafts, summaries) go to `./content/<type>/`, never to `./private/workspace/` (legacy).
- Multi-session projects live under `./private/projects/<slug>/`, scaffolded by `/cyber-create-project`.
- All data stays in `./private/` — nothing shared or uploaded.
