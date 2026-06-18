---
name: cyber-telegram
description: Process Telegram messages via GramJS MTProto client. Read messages, generate AI drafts, save drafts. Use when handling Telegram conversations.
---

# cyber-telegram Skill

Process Telegram messages via custom GramJS MCP connector.

**CRITICAL: NEVER SEND MESSAGES. Only save drafts.**

## Capabilities

| Capability | Description |
|------------|-------------|
| **Unread Mode** | Process N unread conversations |
| **User Mode** | Find specific person by username/name (any read state) |
| **Requests Mode** | Process message requests folder (non-contacts) |
| **Draft Replies** | AI generates contextual reply drafts |
| **Save Drafts** | Save drafts to Telegram (no sending) |
| **History** | Save per-person history to vault `context/telegram/` |

## MCP Tools

All tools use the custom connector: `mcp__cybos-telegram__<tool>`

| Tool | Purpose |
|------|---------|
| `read_unread` | Fetch unread dialogs with messages |
| `read_user` | Read conversation with specific user |
| `read_requests` | Read message requests folder |
| `save_draft` | Save draft reply to a chat |
| `list_folders` | List Telegram folders |
| `list_folder_chats` | List chats in a folder |
| `sync_history` | Sync tracked dialogs to vault (SessionStart) |

## Workflow

See `workflows/process-messages.md` for full documentation.

## Safety

Drafts only — never sends messages automatically. User reviews and sends manually in Telegram.
