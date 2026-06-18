#!/usr/bin/env bun
/**
 * Telegram MCP Server — stdio MCP server for Claude
 *
 * Loads secrets from Keychain via gatekeeper.
 * Persists per-user conversation files in vault at private/context/telegram/<slug>.md
 *
 * Modes:
 *   bun server.ts            # MCP stdio mode
 *   bun server.ts --collect  # Sync unread to vault, exit (for SessionStart)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient, connectAuthenticated, hasSession } from "../core/client";
import {
  getUnreadDialogs,
  searchDialogs,
  getDialogList,
  matchDialogFromList,
  resolveEntity,
  getMessages,
  getMessagesSince,
  saveDraft,
  listFolders,
  listFolderChats,
  type DialogInfo,
} from "../core/dialogs";
import { saveConversation, listTrackedConversations } from "../core/conversation";

// --- Collect mode ---
// Only updates conversations that have already been synced (have a vault file).
// To start tracking a new dialog, use list_folders + list_folder_chats and
// call read_user (or sync via the folder workflow) — that creates the file.
async function runCollect(): Promise<void> {
  if (!hasSession()) {
    console.error("Telegram: not authenticated");
    process.exit(1);
  }

  const tracked = listTrackedConversations();
  if (tracked.length === 0) {
    console.log("Telegram: no tracked conversations. Use list_folders + list_folder_chats to add dialogs.");
    console.log("0 dialogs synced");
    process.exit(0);
  }

  const client = await createClient({ caller: "collect", silent: true });
  let synced = 0;
  let totalNew = 0;
  let skipped = 0;

  try {
    await connectAuthenticated(client);

    // Fetch dialog list ONCE to avoid repeated API calls (rate-limit safe)
    const allDialogs = await getDialogList(client, 200);

    for (const t of tracked) {
      const query = t.username ? `@${t.username}` : t.title;
      let match = matchDialogFromList(allDialogs, query);

      // Fallback: resolve by peer ID (works for groups without usernames)
      if (!match && t.peerId) {
        match = await resolveEntity(client, { username: null, title: t.peerId });
      }

      // Fallback: resolve by username or title
      if (!match) {
        match = await resolveEntity(client, { username: t.username, title: t.title });
      }

      if (!match) {
        skipped++;
        continue;
      }

      // Fetch ALL messages newer than last sync. If never synced (lastMessageId=0),
      // fall back to the most recent 30 to avoid pulling full history.
      const messages = t.lastMessageId > 0
        ? await getMessagesSince(client, match.entity, t.lastMessageId)
        : await getMessages(client, match.entity, 30);
      const result = saveConversation(match, messages);
      synced++;
      totalNew += result.newMessages;
    }

    console.log(`${synced} dialogs synced (${skipped} skipped), ${totalNew} new messages`);
  } catch (err: any) {
    console.error("Telegram collect failed:", err.message);
  } finally {
    await client.disconnect();
  }
  process.exit(0);
}

if (process.argv.includes("--collect")) {
  await runCollect();
}

// --- MCP Server mode ---
const server = new Server(
  { name: "cybos-telegram", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "read_unread",
      description: "Read unread messages from tracked dialogs. Returns dialogs with messages.",
      inputSchema: {
        type: "object" as const,
        properties: {
          count: { type: "number", description: "Number of unread dialogs to fetch", default: 5 },
          summary_only: { type: "boolean", description: "Return counts only, no message bodies", default: false },
        },
      },
    },
    {
      name: "read_user",
      description: "Read conversation history with a specific user (search by @username or name)",
      inputSchema: {
        type: "object" as const,
        properties: {
          user: { type: "string", description: "@username or display name" },
          limit: { type: "number", description: "Number of messages to fetch", default: 20 },
        },
        required: ["user"],
      },
    },
    {
      name: "read_requests",
      description: "Read message requests (non-contacts who messaged you)",
      inputSchema: {
        type: "object" as const,
        properties: {
          count: { type: "number", description: "Number of requests to fetch", default: 5 },
        },
      },
    },
    {
      name: "save_draft",
      description: "Save a draft reply to a Telegram chat. Draft appears in message input for user review (NOT sent automatically).",
      inputSchema: {
        type: "object" as const,
        properties: {
          user: { type: "string", description: "@username or display name to find the chat" },
          text: { type: "string", description: "Draft message text" },
        },
        required: ["user", "text"],
      },
    },
    {
      name: "list_folders",
      description: "List all Telegram folders (chat filters) with names, IDs, and chat counts",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "list_folder_chats",
      description: "List all chats in a specific folder",
      inputSchema: {
        type: "object" as const,
        properties: {
          folder: { type: "string", description: "Folder name or numeric ID" },
        },
        required: ["folder"],
      },
    },
  ],
}));

async function withClient<T>(fn: (client: Awaited<ReturnType<typeof createClient>>) => Promise<T>): Promise<T> {
  if (!hasSession()) {
    throw new Error("Telegram session not found. Run: bun connectors/telegram/auth.ts");
  }
  const client = await createClient({ caller: "mcp", silent: true });
  try {
    await connectAuthenticated(client);
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

function formatDialogSummary(dialog: DialogInfo): string {
  const tag = dialog.username ? `@${dialog.username}` : `#${dialog.id}`;
  return `**${dialog.title}** (${tag}) — ${dialog.unreadCount} unread`;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "read_unread": {
        const count = (args as any)?.count ?? 5;
        const summaryOnly = (args as any)?.summary_only === true;

        return await withClient(async (client) => {
          const unread = await getUnreadDialogs(client, count);
          if (unread.length === 0) {
            return { content: [{ type: "text", text: "No unread dialogs." }] };
          }

          if (summaryOnly) {
            const text = unread.map(formatDialogSummary).join("\n");
            return { content: [{ type: "text", text }] };
          }

          const blocks: string[] = [];
          for (const dialog of unread) {
            const limit = Math.min(dialog.unreadCount + 5, 30);
            const messages = await getMessages(client, dialog.entity, limit);
            saveConversation(dialog, messages);

            blocks.push(`## ${dialog.title}${dialog.username ? ` (@${dialog.username})` : ""}`);
            blocks.push(`Unread: ${dialog.unreadCount}`);
            blocks.push("");
            for (const msg of messages.slice(-Math.min(dialog.unreadCount + 3, 10))) {
              const time = msg.date.toISOString().slice(11, 16);
              const sender = msg.isOutgoing ? "Me" : msg.sender;
              blocks.push(`- [${time}] **${sender}**: ${msg.text.slice(0, 500)}`);
            }
            blocks.push("");
          }
          return { content: [{ type: "text", text: blocks.join("\n") }] };
        });
      }

      case "read_user": {
        const user = (args as any)?.user;
        const limit = (args as any)?.limit ?? 20;
        if (!user) return { content: [{ type: "text", text: "Error: user required" }] };

        return await withClient(async (client) => {
          const matches = await searchDialogs(client, user);
          if (matches.length === 0) {
            return { content: [{ type: "text", text: `No dialog found matching "${user}"` }] };
          }

          const dialog = matches[0];
          const messages = await getMessages(client, dialog.entity, limit);
          saveConversation(dialog, messages);

          const lines = [
            `## ${dialog.title}${dialog.username ? ` (@${dialog.username})` : ""}`,
            `Type: ${dialog.type}`,
            "",
          ];
          for (const msg of messages) {
            const time = msg.date.toISOString().slice(11, 16);
            const date = msg.date.toISOString().slice(0, 10);
            const sender = msg.isOutgoing ? "Me" : msg.sender;
            lines.push(`- [${date} ${time}] **${sender}**: ${msg.text}`);
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        });
      }

      case "read_requests": {
        const count = (args as any)?.count ?? 5;

        return await withClient(async (client) => {
          const requests = await getUnreadDialogs(client, count, { includeRequests: true });
          if (requests.length === 0) {
            return { content: [{ type: "text", text: "No message requests." }] };
          }

          const blocks: string[] = [];
          for (const dialog of requests) {
            const messages = await getMessages(client, dialog.entity, 5);
            blocks.push(`## ${dialog.title}${dialog.username ? ` (@${dialog.username})` : ""}`);
            for (const msg of messages) {
              const time = msg.date.toISOString().slice(11, 16);
              blocks.push(`- [${time}] ${msg.text.slice(0, 300)}`);
            }
            blocks.push("");
          }
          return { content: [{ type: "text", text: blocks.join("\n") }] };
        });
      }

      case "save_draft": {
        const user = (args as any)?.user;
        const text = (args as any)?.text;
        if (!user || !text) {
          return { content: [{ type: "text", text: "Error: user and text required" }] };
        }

        return await withClient(async (client) => {
          const matches = await searchDialogs(client, user);
          if (matches.length === 0) {
            return { content: [{ type: "text", text: `No dialog found matching "${user}"` }] };
          }
          const dialog = matches[0];
          await saveDraft(client, dialog.entity, text);
          return {
            content: [{
              type: "text",
              text: `Draft saved to ${dialog.title}${dialog.username ? ` (@${dialog.username})` : ""}. Open Telegram to review and send.`,
            }],
          };
        });
      }

      case "list_folders": {
        return await withClient(async (client) => {
          const folders = await listFolders(client);
          if (folders.length === 0) {
            return { content: [{ type: "text", text: "No folders configured." }] };
          }
          const text = folders
            .map((f) => `- ${f.title} (id: ${f.id}, ${f.includePeersCount + f.pinnedCount} chats)`)
            .join("\n");
          return { content: [{ type: "text", text }] };
        });
      }

      case "list_folder_chats": {
        const folder = (args as any)?.folder;
        if (!folder) return { content: [{ type: "text", text: "Error: folder required" }] };

        return await withClient(async (client) => {
          const result = await listFolderChats(client, folder);
          if (!result) return { content: [{ type: "text", text: `Folder not found: "${folder}"` }] };
          const lines = [`# ${result.folder} (${result.chats.length} chats)`, ""];
          for (const chat of result.chats) {
            const tag = chat.username ? `@${chat.username}` : `#${chat.id}`;
            lines.push(`- **${chat.title}** (${tag}) — ${chat.type}`);
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        });
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
