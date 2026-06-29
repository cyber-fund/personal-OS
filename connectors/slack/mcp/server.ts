#!/usr/bin/env bun
/**
 * Slack MCP Server — read channels/threads and post messages via the Slack Web API.
 *
 * Auth: bot token in macOS Keychain (cybos.slack / SLACK_BOT_TOKEN, xoxb-...).
 *   - read + post use the bot token (the bot must be invited to channels it reads/posts in).
 *   - search_messages needs a user token (cybos.slack / SLACK_USER_TOKEN, xoxp-...).
 *
 * Bot token scopes needed: channels:read, groups:read, channels:history,
 * groups:history, users:read, chat:write.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getSecretUngated } from "../../_shared/keychain-gate";
import {
  SLACK_API_BASE,
  formatChannels,
  formatMessages,
  buildPostBody,
  type SlackChannel,
  type SlackMessage,
} from "./format";

function getBotToken(): string | null {
  return getSecretUngated("slack", "SLACK_BOT_TOKEN", "mcp");
}

function getUserToken(): string | null {
  return getSecretUngated("slack", "SLACK_USER_TOKEN", "mcp");
}

const MISSING_TOKEN_MSG =
  "No Slack bot token configured. Store it with:\n" +
  "  security add-generic-password -s cybos.slack -a SLACK_BOT_TOKEN -w 'xoxb-...' -U";

async function slackGet(token: string, method: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SLACK_API_BASE}/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method} error: ${data.error ?? res.status}`);
  return data;
}

async function slackPost(token: string, method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method} error: ${data.error ?? res.status}`);
  return data;
}

/** Resolve a small set of user ids to display names (best-effort, ignores failures). */
async function resolveUserNames(token: string, ids: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const id of [...new Set(ids)].slice(0, 50)) {
    try {
      const data = await slackGet(token, "users.info", { user: id });
      const u = data.user;
      map[id] = u?.profile?.display_name || u?.real_name || u?.name || id;
    } catch {
      /* leave unresolved */
    }
  }
  return map;
}

const server = new Server(
  { name: "cybos-slack", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_channels",
      description: "List Slack channels the bot can see (public + private it belongs to).",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Max channels (default 100)", default: 100 },
        },
      },
    },
    {
      name: "read_channel",
      description: "Read recent messages from a channel by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: { type: "string", description: "Channel ID (from list_channels)" },
          count: { type: "number", description: "Number of messages (default 20, max 100)", default: 20 },
        },
        required: ["channel"],
      },
    },
    {
      name: "read_thread",
      description: "Read replies in a thread by channel ID and parent message ts.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: { type: "string", description: "Channel ID" },
          thread_ts: { type: "string", description: "Parent message timestamp (ts)" },
        },
        required: ["channel", "thread_ts"],
      },
    },
    {
      name: "search_messages",
      description: "Search messages with Slack query syntax. Requires a user token (SLACK_USER_TOKEN).",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Slack search query, e.g. 'in:#general from:@me roadmap'" },
          count: { type: "number", description: "Max results (default 20)", default: 20 },
        },
        required: ["query"],
      },
    },
    {
      name: "post_message",
      description: "Post a message to a channel or thread. WRITE action — always confirm the exact text and destination with the user before calling.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: { type: "string", description: "Channel ID to post in" },
          text: { type: "string", description: "Message text" },
          thread_ts: { type: "string", description: "Reply in this thread (optional)" },
        },
        required: ["channel", "text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const token = getBotToken();

  if (name === "search_messages") {
    const userToken = getUserToken();
    if (!userToken) {
      return { content: [{ type: "text", text: "search_messages needs a user token. Store one with:\n  security add-generic-password -s cybos.slack -a SLACK_USER_TOKEN -w 'xoxp-...' -U" }] };
    }
    const query = (args as any)?.query;
    if (!query) return { content: [{ type: "text", text: "Error: query required" }] };
    const count = Math.min((args as any)?.count ?? 20, 100);
    try {
      const data = await slackGet(userToken, "search.messages", { query, count: String(count) });
      const matches: SlackMessage[] = (data.messages?.matches ?? []).map((m: any) => ({
        ts: m.ts, user: m.user ?? m.username, text: m.text,
      }));
      return { content: [{ type: "text", text: matches.length ? formatMessages(matches) : `No matches for "${query}"` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Slack search error: ${e.message}` }] };
    }
  }

  if (!token) return { content: [{ type: "text", text: MISSING_TOKEN_MSG }] };

  switch (name) {
    case "list_channels": {
      const limit = Math.min((args as any)?.limit ?? 100, 1000);
      try {
        const data = await slackGet(token, "conversations.list", {
          types: "public_channel,private_channel",
          exclude_archived: "true",
          limit: String(limit),
        });
        const channels: SlackChannel[] = (data.channels ?? []).map((c: any) => ({
          id: c.id, name: c.name, is_private: c.is_private, is_member: c.is_member,
        }));
        return { content: [{ type: "text", text: formatChannels(channels) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Slack error: ${e.message}` }] };
      }
    }

    case "read_channel": {
      const channel = (args as any)?.channel;
      if (!channel) return { content: [{ type: "text", text: "Error: channel required" }] };
      const count = Math.min((args as any)?.count ?? 20, 100);
      try {
        const data = await slackGet(token, "conversations.history", { channel, limit: String(count) });
        const messages: SlackMessage[] = data.messages ?? [];
        const names = await resolveUserNames(token, messages.map((m) => m.user).filter(Boolean) as string[]);
        return { content: [{ type: "text", text: formatMessages(messages, names) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Slack error: ${e.message}` }] };
      }
    }

    case "read_thread": {
      const channel = (args as any)?.channel;
      const threadTs = (args as any)?.thread_ts;
      if (!channel || !threadTs) return { content: [{ type: "text", text: "Error: channel and thread_ts required" }] };
      try {
        const data = await slackGet(token, "conversations.replies", { channel, ts: threadTs });
        const messages: SlackMessage[] = data.messages ?? [];
        const names = await resolveUserNames(token, messages.map((m) => m.user).filter(Boolean) as string[]);
        return { content: [{ type: "text", text: formatMessages(messages, names) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Slack error: ${e.message}` }] };
      }
    }

    case "post_message": {
      const channel = (args as any)?.channel;
      const text = (args as any)?.text;
      const threadTs = (args as any)?.thread_ts;
      if (!channel || !text) return { content: [{ type: "text", text: "Error: channel and text required" }] };
      try {
        const data = await slackPost(token, "chat.postMessage", buildPostBody(channel, text, threadTs));
        return { content: [{ type: "text", text: `Message posted to ${channel} (ts: ${data.ts}).` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Slack post error: ${e.message}` }] };
      }
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
