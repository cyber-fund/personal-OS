# Telegram Message Processing Workflow

## Modes

- **Unread** (default): `--count N` for N unread conversations
- **User**: `--user "@username"` or `--user "Name"` for specific person
- **Requests**: `--requests` for message requests folder

## Steps

### 1. FETCH MESSAGES

Based on the mode, call the appropriate MCP tool:
- Unread: `mcp__cybos-telegram__read_unread` with `count` parameter
- User: `mcp__cybos-telegram__read_user` with `user` parameter
- Requests: `mcp__cybos-telegram__read_requests`

The tool returns JSON with dialogs and messages. It also writes per-person history to `~/personal-OS-vault/private/context/telegram/<person-slug>.md`.

### 2. REVIEW MESSAGES

For each dialog returned:
- Read the conversation context
- Note the language (Russian/English/other)
- Identify key points that need response
- Check if there's prior context in vault

### 3. GENERATE DRAFT REPLIES

For each conversation that needs a reply:
- **Match language** — reply in the same language as the conversation
- **Be conversational** — match the tone (formal/casual)
- **Reference specifics** — mention actual content from messages
- **Keep it concise** — don't over-explain

Format each draft as:

```
### Dialog: <name>
**Draft Reply:**
<draft text>
```

### 4. PRESENT FOR APPROVAL

Show all drafts to the user with previews. For each draft, ask:
- **approve** — save this draft to Telegram
- **edit** — modify the draft (user provides changes)
- **skip** — don't save this draft

### 5. SAVE DRAFTS TO TELEGRAM

For each approved draft:
- Call `mcp__cybos-telegram__save_draft` with `chat_id` and `text`
- Draft appears in the message input field in Telegram for user review
- Report success/failure for each draft

### 6. REPORT SUMMARY

```
Processed: N dialog(s)
Drafts saved: M
Skipped: K
```

### 7. LOG

Append to vault session log.

## Quality Gates

- [ ] All messages captured and reviewed
- [ ] Draft replies are contextual, not generic
- [ ] Language matches conversation language
- [ ] Drafts saved to Telegram (not sent)

## Dry Run Mode

If `--dry-run` is specified:
- Read and display messages
- Generate drafts for review
- Do NOT save drafts to Telegram
- Useful for checking unread messages without acting
