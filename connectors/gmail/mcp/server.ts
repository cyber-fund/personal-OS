#!/usr/bin/env bun
/**
 * Gmail MCP Server — reads and drafts emails via Gmail REST API with OAuth2.
 *
 * Auth: OAuth2 refresh token (stored in macOS Keychain).
 * Requires a Google Cloud project with Gmail API enabled and OAuth credentials.
 *
 * Stores synced emails in vault at private/context/emails/<date>_<slug>.md
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, writeFileSync } from "fs";
import {
  resolveVaultPath,
  ensureVaultDir,
  readVaultFile,
  writeVaultFile,
  readSyncState,
  writeSyncState,
  nameToSlug,
  formatISO,
} from "../../_shared/vault";
import { appendToInbox } from "../../shared/inbox";
import { getSecretUngated } from "../../_shared/keychain-gate";

// --- Constants ---

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SYNC_DAYS_DEFAULT = 7;

// --- Types ---

interface Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  labelIds?: string[];
  payload?: {
    headers: Array<{ name: string; value: string }>;
    mimeType?: string;
    body?: { data?: string; size?: number };
    parts?: Array<{
      mimeType?: string;
      body?: { data?: string; size?: number };
      parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
    }>;
  };
  internalDate?: string;
}

// --- Credentials ---

function getCredentials(): Credentials | null {
  const clientId = getSecretUngated("gmail", "GMAIL_CLIENT_ID", "collect");
  const clientSecret = getSecretUngated("gmail", "GMAIL_CLIENT_SECRET", "collect");
  const refreshToken = getSecretUngated("gmail", "GMAIL_REFRESH_TOKEN", "collect");
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

// --- OAuth2 token refresh ---

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(creds: Credentials): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt - 60_000) {
    return cachedAccessToken.token;
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`OAuth2 token refresh failed (${res.status}): ${err}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

// --- Gmail API helpers ---

async function gmailFetch(creds: Credentials, path: string, options?: RequestInit): Promise<any> {
  const token = await getAccessToken(creds);
  const res = await fetch(`${GMAIL_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (res.status === 401) {
    // Token expired, retry once
    cachedAccessToken = null;
    const newToken = await getAccessToken(creds);
    const retry = await fetch(`${GMAIL_API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${newToken}`,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
    if (!retry.ok) throw new Error(`Gmail API error ${retry.status}`);
    return retry.json();
  }

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Gmail API error ${res.status}: ${err}`);
  }

  return res.json();
}

async function listMessages(creds: Credentials, query: string, maxResults?: number): Promise<Array<{ id: string; threadId: string }>> {
  const all: Array<{ id: string; threadId: string }> = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ q: query, maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);

    const data = await gmailFetch(creds, `/messages?${params}`);
    const messages = data.messages ?? [];
    all.push(...messages);

    pageToken = data.nextPageToken;

    if (maxResults && all.length >= maxResults) {
      return all.slice(0, maxResults);
    }
  } while (pageToken);

  return all;
}

async function getMessage(creds: Credentials, messageId: string): Promise<GmailMessage> {
  return gmailFetch(creds, `/messages/${messageId}?format=full`);
}

async function createDraft(creds: Credentials, to: string, subject: string, body: string, threadId?: string): Promise<string> {
  // Build RFC 2822 message
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    body,
  ].join("\r\n");

  const encoded = Buffer.from(headers).toString("base64url");

  const draftBody: any = {
    message: { raw: encoded },
  };
  if (threadId) draftBody.message.threadId = threadId;

  const data = await gmailFetch(creds, "/drafts", {
    method: "POST",
    body: JSON.stringify(draftBody),
  });

  return data.id;
}

// --- Google Calendar API ---

async function calendarFetch(creds: Credentials, path: string): Promise<any> {
  const token = await getAccessToken(creds);
  const res = await fetch(`${CALENDAR_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    cachedAccessToken = null;
    const newToken = await getAccessToken(creds);
    const retry = await fetch(`${CALENDAR_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    if (!retry.ok) throw new Error(`Calendar API error ${retry.status}`);
    return retry.json();
  }

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Calendar API error ${res.status}: ${err}`);
  }

  return res.json();
}

interface CalendarEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  location?: string;
  hangoutLink?: string;
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>;
  status?: string;
}

async function listCalendarEvents(creds: Credentials, days: number = 2): Promise<CalendarEvent[]> {
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });

  const data = await calendarFetch(creds, `/calendars/primary/events?${params}`);
  return (data.items ?? []).filter((e: CalendarEvent) => e.status !== "cancelled");
}

// --- Message parsing ---

function getHeader(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function extractBody(msg: GmailMessage): string {
  const payload = msg.payload;
  if (!payload) return "";

  // Simple message with body directly
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart message — prefer text/plain, fall back to text/html
  if (payload.parts) {
    // Check top-level parts
    const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
    if (textPart?.body?.data) return decodeBase64Url(textPart.body.data);

    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) return stripHtml(decodeBase64Url(htmlPart.body.data));

    // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
    for (const part of payload.parts) {
      if (part.parts) {
        const nestedText = part.parts.find((p) => p.mimeType === "text/plain");
        if (nestedText?.body?.data) return decodeBase64Url(nestedText.body.data);

        const nestedHtml = part.parts.find((p) => p.mimeType === "text/html");
        if (nestedHtml?.body?.data) return stripHtml(decodeBase64Url(nestedHtml.body.data));
      }
    }
  }

  return msg.snippet ?? "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatMessageDate(msg: GmailMessage): string {
  const dateHeader = getHeader(msg, "Date");
  if (dateHeader) {
    try {
      return new Date(dateHeader).toISOString().slice(0, 19).replace("T", " ");
    } catch {}
  }
  if (msg.internalDate) {
    return new Date(parseInt(msg.internalDate)).toISOString().slice(0, 19).replace("T", " ");
  }
  return formatISO();
}

function formatMessageForDisplay(msg: GmailMessage): string {
  const from = getHeader(msg, "From");
  const to = getHeader(msg, "To");
  const subject = getHeader(msg, "Subject");
  const date = formatMessageDate(msg);
  const body = extractBody(msg);
  const isUnread = msg.labelIds?.includes("UNREAD") ?? false;

  const lines = [
    `**From:** ${from}`,
    `**To:** ${to}`,
    `**Subject:** ${subject}`,
    `**Date:** ${date}`,
    `**Status:** ${isUnread ? "Unread" : "Read"}`,
    `**ID:** ${msg.id}`,
    "",
    body,
  ];

  return lines.join("\n");
}

// --- Vault storage ---

/**
 * Extract email address from a "From" header like "John Doe <john@example.com>"
 */
function parseEmailAddress(from: string): { email: string; name: string } {
  const match = from.match(/<([^>]+)>/);
  const email = (match ? match[1] : from).trim().toLowerCase();
  const name = match ? from.replace(/<[^>]+>/, "").trim().replace(/^"|"$/g, "") : email;
  return { email, name };
}

/**
 * Extract domain and local part from email address.
 * "john.doe@example.com" → { domain: "example.com", local: "john-doe" }
 */
function parseEmailParts(email: string): { domain: string; local: string } {
  const [localRaw, domain] = email.split("@");
  return {
    domain: domain || "unknown",
    local: nameToSlug(localRaw || "unknown"),
  };
}

/**
 * Save email to vault with structure:
 *   private/context/emails/<domain>/<local-part>/<date>_<subject-slug>.md
 */
function saveEmailToVault(msg: GmailMessage): void {
  const from = getHeader(msg, "From");
  const to = getHeader(msg, "To");
  const subject = getHeader(msg, "Subject") || "no-subject";
  const date = formatMessageDate(msg);
  const datePrefix = date.slice(0, 10);
  const slug = nameToSlug(subject).slice(0, 50);
  const body = extractBody(msg);

  const { email, name: senderName } = parseEmailAddress(from);
  const { domain, local } = parseEmailParts(email);

  ensureVaultDir("private", "context", "emails", domain, local);

  const filename = `${datePrefix}_${slug}.md`;
  const filePath = resolveVaultPath("private", "context", "emails", domain, local, filename);

  // Skip if already exists
  if (existsSync(filePath)) return;

  const content = `---
date: ${datePrefix}
type: email
from: ${email}
from_name: ${senderName}
to: ${to}
subject: ${subject}
message_id: ${msg.id}
synced_at: ${new Date().toISOString()}
---

# ${subject}

From: ${from}
Date: ${date}

${body}
`;

  writeFileSync(filePath, content);
}

// --- Sync orchestrator ---

const SYNC_MAX_EMAILS = 50;

async function syncEmails(creds: Credentials, days: number = SYNC_DAYS_DEFAULT, maxEmails: number = SYNC_MAX_EMAILS): Promise<{ synced: number; skipped: number; total: number; capped: boolean }> {
  const query = `newer_than:${days}d`;
  const messageRefs = await listMessages(creds, query);

  if (messageRefs.length === 0) return { synced: 0, skipped: 0, total: 0, capped: false };

  const total = messageRefs.length;

  // Load sync state
  const state = readSyncState("private", "context", "emails") ?? { syncedIds: [] };
  const syncedIds = new Set<string>(state.syncedIds ?? []);

  // Filter to only unsynced, then cap
  const unsynced = messageRefs.filter((ref) => !syncedIds.has(ref.id));
  const skipped = messageRefs.length - unsynced.length;
  const capped = unsynced.length > maxEmails;
  const toSync = unsynced.slice(0, maxEmails);

  let synced = 0;
  const inboxEntries: string[] = [];

  for (const ref of toSync) {
    try {
      const msg = await getMessage(creds, ref.id);
      saveEmailToVault(msg);
      syncedIds.add(ref.id);
      synced++;

      // Build inbox entry for this email
      const from = getHeader(msg, "From");
      const subject = getHeader(msg, "Subject") || "no-subject";
      const date = formatMessageDate(msg).slice(0, 10);
      const body = extractBody(msg).replace(/\n/g, " ").slice(0, 200);
      inboxEntries.push(`### From: ${from} | ${subject}\nDate: ${date}\n${body}\n`);
    } catch {
      // Skip individual failures
      continue;
    }
  }

  // Append to daily inbox
  if (inboxEntries.length > 0) {
    appendToInbox("Email", inboxEntries.join("\n"));
  }

  // Update sync state — keep only last 500 IDs
  const idsArray = Array.from(syncedIds).slice(-500);
  writeSyncState(
    { lastSync: new Date().toISOString(), syncedIds: idsArray },
    "private", "context", "emails"
  );

  return { synced, skipped, total, capped };
}

// --- --collect mode ---

if (process.argv.includes("--collect")) {
  const creds = getCredentials();

  if (!creds) {
    console.error("Gmail: no OAuth credentials configured, skipping");
    process.exit(1);
  }

  const syncAll = process.argv.includes("--all");
  try {
    const result = await syncEmails(creds, SYNC_DAYS_DEFAULT, syncAll ? Infinity : SYNC_MAX_EMAILS);
    if (result.capped) {
      console.log(`${result.synced} emails synced (${result.total} total in last 7 days, capped at ${SYNC_MAX_EMAILS}). Run again to sync more, or use: bun connectors/gmail/mcp/server.ts --collect --all to sync all.`);
    } else {
      console.log(`${result.synced} emails synced`);
    }
  } catch (e: any) {
    console.log(`Gmail error: ${e.message}`);
    console.log("0 emails synced");
  }
  process.exit(0);
}

// --- MCP Server mode ---

const server = new Server(
  { name: "cybos-gmail", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_emails",
      description: "List recent emails from inbox",
      inputSchema: {
        type: "object" as const,
        properties: {
          count: { type: "number", description: "Number of emails to list (default 20, max 50)", default: 20 },
          query: { type: "string", description: "Gmail search query (default: in:inbox)", default: "in:inbox" },
        },
      },
    },
    {
      name: "read_email",
      description: "Read the full content of a specific email by message ID",
      inputSchema: {
        type: "object" as const,
        properties: {
          message_id: { type: "string", description: "Gmail message ID" },
        },
        required: ["message_id"],
      },
    },
    {
      name: "search_emails",
      description: "Search emails with Gmail query syntax (e.g. 'from:user@example.com', 'is:unread', 'subject:hello')",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Gmail search query" },
          count: { type: "number", description: "Max results (default 20)", default: 20 },
        },
        required: ["query"],
      },
    },
    {
      name: "list_calendar_events",
      description: "List upcoming Google Calendar events",
      inputSchema: {
        type: "object" as const,
        properties: {
          days: { type: "number", description: "Number of days to look ahead (default 2)", default: 2 },
        },
      },
    },
    {
      name: "create_draft",
      description: "Create a Gmail draft for user review. Does NOT send — user sends manually from Gmail.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject" },
          body: { type: "string", description: "Email body (plain text)" },
          thread_id: { type: "string", description: "Thread ID to reply in (optional)" },
        },
        required: ["to", "subject", "body"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const creds = getCredentials();
  if (!creds) {
    return {
      content: [{
        type: "text",
        text: "No Gmail OAuth credentials configured. Run the setup wizard or store credentials manually:\n" +
          "  security add-generic-password -s cybos.gmail -a GMAIL_CLIENT_ID -w 'VALUE' -U\n" +
          "  security add-generic-password -s cybos.gmail -a GMAIL_CLIENT_SECRET -w 'VALUE' -U\n" +
          "  security add-generic-password -s cybos.gmail -a GMAIL_REFRESH_TOKEN -w 'VALUE' -U",
      }],
    };
  }

  switch (name) {
    case "list_emails": {
      const query = (args as any)?.query ?? "in:inbox";
      const count = Math.min((args as any)?.count ?? 20, 50);

      try {
        const refs = await listMessages(creds, query, count);
        if (refs.length === 0) {
          return { content: [{ type: "text", text: "No emails found." }] };
        }

        const emails: string[] = [];
        for (const ref of refs) {
          const msg = await getMessage(creds, ref.id);
          const from = getHeader(msg, "From");
          const subject = getHeader(msg, "Subject");
          const date = formatMessageDate(msg);
          const unread = msg.labelIds?.includes("UNREAD") ? " [UNREAD]" : "";
          emails.push(`- **${subject}**${unread}\n  From: ${from} | ${date} | ID: ${msg.id}`);
        }

        return { content: [{ type: "text", text: `Found ${refs.length} email(s):\n\n${emails.join("\n\n")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Gmail error: ${e.message}` }] };
      }
    }

    case "read_email": {
      const messageId = (args as any)?.message_id;
      if (!messageId) return { content: [{ type: "text", text: "Error: message_id required" }] };

      try {
        const msg = await getMessage(creds, messageId);
        return { content: [{ type: "text", text: formatMessageForDisplay(msg) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error reading email: ${e.message}` }] };
      }
    }

    case "search_emails": {
      const query = (args as any)?.query;
      if (!query) return { content: [{ type: "text", text: "Error: query required" }] };
      const count = Math.min((args as any)?.count ?? 20, 50);

      try {
        const refs = await listMessages(creds, query, count);
        if (refs.length === 0) {
          return { content: [{ type: "text", text: `No emails matching "${query}"` }] };
        }

        const emails: string[] = [];
        for (const ref of refs) {
          const msg = await getMessage(creds, ref.id);
          const from = getHeader(msg, "From");
          const subject = getHeader(msg, "Subject");
          const date = formatMessageDate(msg);
          const unread = msg.labelIds?.includes("UNREAD") ? " [UNREAD]" : "";
          emails.push(`- **${subject}**${unread}\n  From: ${from} | ${date} | ID: ${msg.id}`);
        }

        return { content: [{ type: "text", text: `${refs.length} result(s) for "${query}":\n\n${emails.join("\n\n")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Gmail search error: ${e.message}` }] };
      }
    }

    case "list_calendar_events": {
      const days = (args as any)?.days ?? 2;

      try {
        const events = await listCalendarEvents(creds, days);
        if (events.length === 0) {
          return { content: [{ type: "text", text: `No events in the next ${days} day(s).` }] };
        }

        // Group by date
        const grouped = new Map<string, CalendarEvent[]>();
        for (const ev of events) {
          const start = ev.start?.dateTime ?? ev.start?.date ?? "";
          const dateKey = start.slice(0, 10);
          if (!grouped.has(dateKey)) grouped.set(dateKey, []);
          grouped.get(dateKey)!.push(ev);
        }

        const sections: string[] = [];
        for (const [date, dayEvents] of grouped) {
          const dayLabel = new Date(date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
          const rows = dayEvents.map((ev) => {
            const start = ev.start?.dateTime
              ? new Date(ev.start.dateTime).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
              : "All day";
            const end = ev.end?.dateTime
              ? new Date(ev.end.dateTime).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
              : "";
            const time = end ? `${start} – ${end}` : start;
            const title = ev.summary ?? "(No title)";
            const attendees = ev.attendees?.map((a) => a.displayName ?? a.email).join(", ") ?? "";
            const location = ev.location ?? ev.hangoutLink ?? "";
            return `| ${time} | ${title} | ${attendees} | ${location} |`;
          });

          sections.push(`### ${dayLabel}\n\n| Time | Event | Attendees | Location |\n|------|-------|-----------|----------|\n${rows.join("\n")}`);
        }

        return { content: [{ type: "text", text: sections.join("\n\n") }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Calendar error: ${e.message}` }] };
      }
    }

    case "create_draft": {
      const to = (args as any)?.to;
      const subject = (args as any)?.subject;
      const body = (args as any)?.body;
      const threadId = (args as any)?.thread_id;

      if (!to || !subject || !body) {
        return { content: [{ type: "text", text: "Error: to, subject, and body are required" }] };
      }

      try {
        const draftId = await createDraft(creds, to, subject, body, threadId);
        return { content: [{ type: "text", text: `Draft created (ID: ${draftId}). Open Gmail to review and send.` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error creating draft: ${e.message}` }] };
      }
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
