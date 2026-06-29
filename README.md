# personal-OS

A personal AI workspace built on Claude Code. It connects your Telegram, Google Workspace (Gmail, Calendar, Docs, Sheets, Slides), Twitter, Granola, Asana, Slack, Typefully, and Notion into one system where Claude works with full context across your messages, meetings, research, and projects.

> **This is a starting point, not a finished product.** personal-OS gives you a clean, working baseline — a handful of skills, connectors, and a vault structure — so you have *something* running on day one. It is meant to **evolve**: as you use it, the repetitive work you do with Claude is what tells you which new skills to add, which workflows to encode, and which defaults to change. Treat the skills below as examples of the pattern, then grow your own. See [Make it yours](#make-it-yours).

---

## Quick Start

### 1. Clone

```bash
git clone https://github.com/cyber-fund/personal-OS.git
cd personal-OS
```

On first `claude` run, the bootstrap script installs [Bun](https://bun.sh) (if missing) and project dependencies automatically.

### 2. Run Claude Code and complete setup

```bash
claude
```

On first run a setup wizard opens at `http://localhost:3847/setup`. Then run `/cyber-setup` from inside Claude. It captures:

1. **Identity** — your name, role, organization, priorities, handles
2. **Vault location** — where your personal data lives (default: `~/personal-OS-vault`)
3. **Connectors** — Telegram, Gmail (OAuth), Twitter, Granola, Asana keys — all stored in macOS Keychain
4. **Voice** — your writing style and tone

### 3. Connect built-in MCPs

Run `/mcp` and connect **Google Calendar**, **Typefully**, and (optional) **Notion**. One-time browser auth per service.

### 4. Pull in your data

```bash
bun scripts/collect.ts     # sync all connectors into the vault
```

---

## Skills

Skills are plain markdown in `.claude/skills/`, invoked as `/skill-name`. They call connector/MCP tools and read/write the vault. There are nine.

### Setup & projects

| Skill | What it does | Use it when |
|-------|-------------|-------------|
| `/cyber-setup` | Builds the workspace, runs the identity/voice interview, seeds org context, creates `GTD.md` | First run, or to re-run onboarding |
| `/cyber-create-project` | Scaffolds `vault/private/projects/<slug>/` (CLAUDE.md, README, status, decisions, context/, deliverables/) and links it in GTD | Any multi-session piece of work that needs a home |
| `/cyber-context` | Dashboard of active projects + recent comms signals (who/what relates to each project) | "What's happening across my projects? What should I focus on?" |

### Inbox (read → draft, never auto-send)

| Skill | What it does | Use it when |
|-------|-------------|-------------|
| `/cyber-brief` | One situational brief from Telegram + email + calendar + Twitter | Start of day, or before a focus block |
| `/cyber-telegram` | Reads Telegram (GramJS/MTProto), drafts contextual replies, **saves** them for review | Clearing Telegram |
| `/cyber-email` | Reads unread Gmail, drafts replies, syncs threads to the vault | Clearing email |

### Research & content

| Skill | What it does | Use it when |
|-------|-------------|-------------|
| `/cyber-research "topic"` | Company DD / tech deep-dive / market analysis at 3 depths (quick / standard / deep) | Diligence, a deep-dive, or seeding a project's context |
| `/cyber-twitter` | Analyzes feed trends + your post performance, drafts tweets/threads; the prompt self-improves from engagement | Creating posts, or studying what's landing |
| `/cyber-schedule @file.md` | Schedules finished text content to Twitter/LinkedIn via Typefully | Publishing something already written |

### Utility commands (no skill, just a command)

| Command | What it does |
|---------|-------------|
| `/cyber-calendar` | Show upcoming calendar events |
| `/cyber-save-calls` | Extract new Granola meeting transcripts into the vault |
| `/cyber-update` | Pull the latest skills/connectors from git |

**The golden rule:** the inbox skills never send anything. They produce drafts and save them for you to review and send yourself.

---

## Architecture

Three cleanly separated layers:

```
┌──────────────────────────────────────┐
│  Layer 3: SKILLS & WORKFLOWS         │
│  .claude/{commands,skills}/          │
│  Pure markdown. Calls MCP tools.     │
├──────────────────────────────────────┤
│  Layer 2: CONNECTORS                 │
│  Custom: connectors/{telegram,       │
│    twitter,gmail,granola,asana,      │
│    slack}/  (gmail = Workspace)      │
│  Built-in: Typefully, Notion         │
│    (via /mcp)                        │
├──────────────────────────────────────┤
│  Layer 1: DATA VAULT                 │
│  ~/personal-OS-vault/                │
│  Pure markdown. No code.             │
└──────────────────────────────────────┘
```

### What goes where

| Location | Contains | In git? |
|----------|----------|---------|
| `personal-OS/` (this repo) | Skills, connectors, scripts, config | Yes |
| `~/personal-OS-vault/` | Personal data (messages, emails, research, projects) | No |
| `~/.cyboslite/` | Config, secrets manifest, logs | No |
| macOS Keychain | API keys, OAuth tokens | No |

Your personal data and secrets live **outside** this repo by design — so the code can be shared while your data never leaves your machine.

---

## Connectors

### Custom (code in this repo)

| Connector | What it does | Auth |
|-----------|-------------|------|
| **Telegram** | Read messages, save drafts via GramJS MTProto | Keychain (API_ID, API_HASH, SESSION) |
| **Google Workspace** | Gmail read/draft, Calendar read **+ event create** (approval-gated), read-only Docs/Sheets/Slides | Keychain (OAuth2 client + refresh token) |
| **Twitter** | Read the Following timeline, track accounts | Keychain (auth_token + ct0 cookies) |
| **Granola** | Extract meeting transcripts + summaries. Two modes: **API** (paid key) or **scrape** (no key — reads the local Granola cache; ⚠ unstable, may break on Granola updates) | Keychain (API key) for API mode; none for scrape |
| **Asana** | Read projects/tasks, set fields, comment | Keychain (access token) |
| **Slack** | Read channels/threads, post messages (approval-gated); search needs a user token | Keychain (bot token; optional user token) |

> The Google connector's directory is still `connectors/gmail/` and its MCP name is `cybos-gmail` (kept for compatibility), but it now covers all of Google Workspace. Expanding Docs/Sheets/Slides + calendar write broadened the OAuth scopes — if you connected Gmail before this change, **re-run the OAuth flow** so your refresh token carries the new scopes.

### Built-in (connected via `/mcp`)

| Service | What it does |
|---------|-------------|
| **Typefully** | Schedule posts to Twitter/LinkedIn |
| **Notion** | Search, read, create pages |

---

## Security

- **Secrets never touch Claude** — API keys and tokens live in macOS Keychain, accessed via a gatekeeper with optional Touch ID approval. Nothing sensitive is in this repo.
- **Draft-only** — Claude never sends messages or emails; it saves drafts for your review.
- **Gmail scopes** — the connector only creates drafts, never calls the send endpoint.
- **Keychain protected** — `settings.json` deny rules block Claude from running `security` commands.
- **Your data stays local** — the vault and `~/.cyboslite/` are git-ignored; only code is tracked.

> If you fork this repo public, remember: the code being public is fine — your Keychain secrets are what protect your accounts. Never paste a session string or token into a file.

---

## Make it yours

personal-OS is deliberately small. The point is not the nine skills shipped here — it's the **pattern**: a skill is just a markdown file that describes a repeatable task, and a connector is just a small MCP server that brings a data source in.

Let your real work drive what you build next:

- **Notice repetition.** Any task you walk Claude through more than twice is a candidate for a skill. Copy an existing `.claude/skills/<x>/SKILL.md` as a template and write down the steps.
- **Scaffold a project for anything multi-session** with `/cyber-create-project`, and let `decisions.md` capture the *why* so future sessions stay coherent.
- **Tune the defaults.** Your voice (`voice-identity`, `posting-prompt`), your org context (`cyber.md`), and your priorities (`who-am-i.md`) all live in the vault — edit them as you learn what works.
- **Add connectors** for the sources you actually live in; remove the ones you don't.
- **Let skills self-improve** — `cyber-twitter` already adjusts its prompt from engagement data; the same loop works for any skill where you can measure outcomes.

The version you run in six months should look noticeably different from this one. That's the intended outcome.

---

## Updating

```bash
/cyber-update
```

Or manually:

```bash
git pull origin main
bun scripts/generate-mcp-config.ts
```

## Requirements

- macOS (for Keychain + Touch ID)
- [Claude Code](https://claude.ai/claude-code) CLI
- Xcode Command Line Tools (for the Touch ID helper)
- Granola desktop app (optional, for meeting transcripts)

[Bun](https://bun.sh) is auto-installed on first run if missing.
