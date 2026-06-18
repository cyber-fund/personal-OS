/**
 * Per-person conversation file storage.
 * Files live at vault: private/context/telegram/<slug>.md
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import {
  resolveVaultPath,
  ensureVaultDir,
  nameToSlug,
  formatISO,
} from "../../_shared/vault";
import { appendToInbox } from "../../shared/inbox";
import type { DialogInfo, MessageInfo } from "./dialogs";

export interface TrackedConversation {
  slug: string;
  username: string | null;
  title: string;
  type: string;
  lastMessageId: number;
  peerId: string | null;
}

interface ConversationMetadata {
  entitySlug: string;
  username: string | null;
  type: string;
  firstContact: string;
  lastUpdated: string;
  lastMessageId: number;
  peerId: string | null;
}

export function getEntitySlug(dialog: DialogInfo): string {
  if (dialog.username) return nameToSlug(dialog.username);
  return nameToSlug(dialog.title);
}

/**
 * Scan the telegram vault dir and return all conversations that have been
 * previously synced (i.e., have a file). Used by --collect to determine
 * which dialogs to update — initial sync of new dialogs happens manually
 * via list_folders / list_folder_chats.
 */
export function listTrackedConversations(): TrackedConversation[] {
  const dir = resolveVaultPath("private", "context", "telegram");
  if (!existsSync(dir)) return [];

  const result: TrackedConversation[] = [];
  for (const filename of readdirSync(dir)) {
    if (!filename.endsWith(".md")) continue;
    const slug = filename.slice(0, -3);
    const content = readFileSync(`${dir}/${filename}`, "utf-8");
    const meta = parseMetadata(content);
    if (!meta) continue;

    // Extract title from first heading
    const titleMatch = content.match(/^# (.+)$/m);
    result.push({
      slug,
      username: meta.username,
      title: titleMatch?.[1] ?? slug,
      type: meta.type,
      lastMessageId: meta.lastMessageId,
      peerId: meta.peerId,
    });
  }
  return result;
}

function getFilePath(slug: string): string {
  return resolveVaultPath("private", "context", "telegram", `${slug}.md`);
}

function parseMetadata(content: string): ConversationMetadata | null {
  const lines = content.split("\n");
  const meta: ConversationMetadata = {
    entitySlug: "",
    username: null,
    type: "private",
    firstContact: "",
    lastUpdated: "",
    lastMessageId: 0,
    peerId: null,
  };

  for (const line of lines) {
    if (line.startsWith("**Entity:**")) meta.entitySlug = line.replace("**Entity:**", "").trim();
    else if (line.startsWith("**Username:**")) {
      const v = line.replace("**Username:**", "").trim();
      meta.username = v === "none" ? null : v.replace("@", "");
    } else if (line.startsWith("**Type:**")) meta.type = line.replace("**Type:**", "").trim();
    else if (line.startsWith("**First contact:**")) meta.firstContact = line.replace("**First contact:**", "").trim();
    else if (line.startsWith("**Last updated:**")) meta.lastUpdated = line.replace("**Last updated:**", "").trim();
    else if (line.startsWith("**Last message ID:**")) {
      meta.lastMessageId = parseInt(line.replace("**Last message ID:**", "").trim(), 10) || 0;
    } else if (line.startsWith("**Peer ID:**")) {
      const v = line.replace("**Peer ID:**", "").trim();
      meta.peerId = v === "none" ? null : v;
    }
  }

  return meta;
}

function groupByDate(messages: MessageInfo[]): Map<string, MessageInfo[]> {
  const grouped = new Map<string, MessageInfo[]>();
  for (const msg of messages) {
    const date = msg.date.toISOString().slice(0, 10);
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date)!.push(msg);
  }
  return grouped;
}

function formatMessage(msg: MessageInfo): string {
  const time = msg.date.toISOString().slice(11, 16);
  const sender = msg.isOutgoing ? "Me" : msg.sender;
  const text = msg.text.replace(/\n/g, " ");
  return `- [${time}] **${sender}**: ${text}`;
}

/**
 * Write or update a conversation file with new messages.
 * Returns the count of newly added messages.
 */
export function saveConversation(
  dialog: DialogInfo,
  messages: MessageInfo[]
): { slug: string; newMessages: number; filePath: string } {
  ensureVaultDir("private", "context", "telegram");
  const slug = getEntitySlug(dialog);
  const filePath = getFilePath(slug);

  if (!existsSync(filePath)) {
    // Create new file
    const lines: string[] = [];
    lines.push(`# ${dialog.title}`, "");
    lines.push(`**Entity:** ${slug}`);
    lines.push(`**Peer ID:** ${dialog.id}`);
    lines.push(`**Username:** ${dialog.username ? `@${dialog.username}` : "none"}`);
    lines.push(`**Type:** ${dialog.type}`);
    lines.push(`**First contact:** ${formatISO()}`);
    lines.push(`**Last updated:** ${new Date().toISOString()}`);
    const maxId = messages.length > 0 ? Math.max(...messages.map((m) => m.id)) : 0;
    lines.push(`**Last message ID:** ${maxId}`, "", "---", "");

    const grouped = groupByDate(messages);
    for (const [date, msgs] of grouped) {
      lines.push(`## ${date}`, "");
      for (const msg of msgs) lines.push(formatMessage(msg));
      lines.push("");
    }
    lines.push("---", "");
    writeFileSync(filePath, lines.join("\n"), "utf-8");

    // Append to daily inbox
    if (messages.length > 0) {
      appendTelegramToInbox(dialog, messages);
    }

    return { slug, newMessages: messages.length, filePath };
  }

  // Append to existing file
  const content = readFileSync(filePath, "utf-8");
  const meta = parseMetadata(content);
  const newMessages = messages.filter((m) => m.id > (meta?.lastMessageId ?? 0));
  if (newMessages.length === 0) return { slug, newMessages: 0, filePath };

  const lines = content.split("\n");
  const maxId = Math.max(meta?.lastMessageId ?? 0, ...newMessages.map((m) => m.id));

  // Update metadata
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("**Last updated:**")) lines[i] = `**Last updated:** ${new Date().toISOString()}`;
    if (lines[i].startsWith("**Last message ID:**")) lines[i] = `**Last message ID:** ${maxId}`;
  }

  // Find last "---" to insert before it
  let insertIdx = lines.length - 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === "---") {
      insertIdx = i;
      break;
    }
  }

  // Insert new messages grouped by date
  const grouped = groupByDate(newMessages);
  const insertion: string[] = [];
  for (const [date, msgs] of grouped) {
    const existingDateIdx = lines.findIndex((l) => l === `## ${date}`);
    if (existingDateIdx >= 0) {
      // Append within existing date section
      let appendAt = existingDateIdx + 1;
      while (
        appendAt < insertIdx &&
        !lines[appendAt].startsWith("## ") &&
        lines[appendAt] !== "---"
      ) {
        appendAt++;
      }
      const formatted = msgs.map(formatMessage);
      lines.splice(appendAt, 0, ...formatted);
      insertIdx += formatted.length;
    } else {
      insertion.push(`## ${date}`, "");
      for (const msg of msgs) insertion.push(formatMessage(msg));
      insertion.push("");
    }
  }

  if (insertion.length > 0) lines.splice(insertIdx, 0, ...insertion);

  writeFileSync(filePath, lines.join("\n"), "utf-8");

  // Append new messages to daily inbox
  if (newMessages.length > 0) {
    appendTelegramToInbox(dialog, newMessages);
  }

  return { slug, newMessages: newMessages.length, filePath };
}

/**
 * Append new Telegram messages to the shared daily inbox file.
 */
function appendTelegramToInbox(dialog: DialogInfo, messages: MessageInfo[]): void {
  const handle = dialog.username ? ` (@${dialog.username})` : "";
  const lines: string[] = [];
  lines.push(`### ${dialog.title}${handle}`);

  for (const msg of messages) {
    const time = msg.date.toISOString().slice(11, 16);
    const sender = msg.isOutgoing ? "Me" : msg.sender;
    const text = msg.text.replace(/\n/g, " ").slice(0, 500);
    lines.push(`- [${time}] **${sender}**: ${text}`);
  }

  appendToInbox("Telegram", lines.join("\n"));
}
