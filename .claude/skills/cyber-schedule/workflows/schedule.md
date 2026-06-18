# Social Media Scheduling Workflow

## MCP Tools (Claude.ai Built-in Typefully)

- `mcp__claude_ai_Typefully__get_me` — current user info
- `mcp__claude_ai_Typefully__list_social_sets` — list accounts
- `mcp__claude_ai_Typefully__create_draft` — create/schedule post

## Steps

### 1. PARSE ARGUMENTS

- Content: file path (@-prefixed) OR raw text
- Account: optional `--account` flag
- Image: not supported in v1

### 2. READ CONTENT

If @-prefixed path: read the file, detect type (tweet/post/essay), extract content.
If raw text: use as-is.

### 3. SOCIAL SET SELECTION

Call `mcp__claude_ai_Typefully__list_social_sets` to show available accounts.
Ask user which account to use (default: first account).

### 4. PLATFORM SELECTION

Ask: Twitter / LinkedIn / Both

### 5. TIMING SELECTION

Options:
- **Draft** — save as draft in Typefully
- **Now** — publish immediately
- **Queue** — add to next free slot
- **Scheduled** — set specific date/time (ISO-8601)

### 6. CREATE DRAFT

Call `mcp__claude_ai_Typefully__create_draft` with:
- social_set_id from step 3
- platform config (x/linkedin enabled/disabled)
- publish_at (now/next-free-slot/ISO datetime)
- content text

### 7. CONFIRM

Display:
- Account used
- Platforms
- Timing
- Status/URL if available

### 8. LOG

Append to vault session log.
