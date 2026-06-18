---
name: cyber-telegram
description: Process Telegram messages - read, draft replies, save drafts via GramJS
---

Process Telegram messages via GramJS MTProto client. Read messages, generate AI drafts, and save drafts to Telegram without sending.

**CRITICAL: NEVER SEND MESSAGES. Only save drafts to Telegram.**

## Usage

```
/cyber-telegram                    # 5 unread dialogs (default)
/cyber-telegram --count 3          # 3 unread dialogs
/cyber-telegram --user "@username" # Specific person
/cyber-telegram --user "Name"      # By name
/cyber-telegram --requests         # Message requests
/cyber-telegram --folders          # List folders
/cyber-telegram --folder "Name"    # List chats in folder
/cyber-telegram --dry-run          # Read only, don't save drafts
```

## Workflow

Full workflow: `.claude/skills/cyber-telegram/workflows/process-messages.md`

### Messages mode (default, --user, --requests)
1. Call `mcp__cybos-telegram__read_unread` (or read_user/read_requests based on mode)
2. Review messages and conversation context
3. Generate contextual draft replies (match language, reference specifics)
4. Present drafts for user approval
5. Call `mcp__cybos-telegram__save_draft` for approved drafts
6. Log activity

### Folders mode (--folders, --folder)
1. `--folders`: Call `mcp__cybos-telegram__list_folders` to list all folders with chat counts
2. `--folder "Name"`: Call `mcp__cybos-telegram__list_folder_chats` to list chats in that folder

## MCP Tools

- `mcp__cybos-telegram__read_unread`
- `mcp__cybos-telegram__read_user`
- `mcp__cybos-telegram__read_requests`
- `mcp__cybos-telegram__save_draft`
- `mcp__cybos-telegram__list_folders`
- `mcp__cybos-telegram__list_folder_chats`
