/**
 * tg-cleanup — chat enumeration + classification.
 *
 * Ruleset (no flags, baked in — see requirements.md):
 *   DM                              -> all  (revoke for everyone)
 *   basic group / supergroup, admin -> all
 *   basic group / supergroup, !admin-> mine
 *   broadcast channel               -> skip (decided 2026-06-15)
 *   Saved Messages (self)           -> skip
 *   pinned messages                 -> never deleted (filtered in counting/execute)
 */

import { TelegramClient, Api } from "telegram";
import type { ChatType, DeleteMode } from "./shared";
import { sleep } from "./shared";

export interface ClassifiedChat {
  chat_id: string; // marked peer id (matches client.getDialogs id)
  raw_id: string; // bare entity id (matches folder-membership ids)
  title: string;
  type: ChatType;
  username: string | null;
  is_admin: boolean;
  mode: DeleteMode;
  reason: string;
  entity: Api.TypeInputPeer; // live, valid only within this process
}

export interface ChatFilters {
  allowedChatIds?: Set<string>; // from --folder
  include?: string[]; // --include-chat (whitelist)
  exclude?: string[]; // --exclude-chat (blacklist)
}

export async function getSelfId(client: TelegramClient): Promise<string> {
  const me = await client.getMe();
  return (me as Api.User).id.toString();
}

function isAdmin(entity: Api.Chat | Api.Channel): boolean {
  if ((entity as any).creator) return true;
  const rights = (entity as any).adminRights as Api.ChatAdminRights | undefined;
  return Boolean(rights?.deleteMessages);
}

function matchesHandle(chat: ClassifiedChat, needle: string): boolean {
  const n = needle.toLowerCase().replace(/^@/, "");
  return (
    (chat.username?.toLowerCase() ?? "").includes(n) ||
    chat.title.toLowerCase().includes(n)
  );
}

function classify(dialog: any, selfId: string): ClassifiedChat | null {
  const entity = dialog.entity;
  const inputPeer = dialog.inputEntity as Api.TypeInputPeer;
  if (!entity || !inputPeer) return null;

  const base = {
    chat_id: dialog.id!.toString(),
    raw_id: entity.id!.toString(),
    entity: inputPeer,
    username: (entity.username as string | undefined) ?? null,
  };

  if (entity instanceof Api.User) {
    const title =
      [entity.firstName, entity.lastName].filter(Boolean).join(" ") ||
      entity.username ||
      "Unknown";
    if (entity.id.toString() === selfId) {
      return {
        ...base,
        title: "Saved Messages",
        type: "private",
        is_admin: false,
        mode: "skip",
        reason: "saved messages — always skipped",
      };
    }
    return {
      ...base,
      title,
      type: "private",
      is_admin: false,
      mode: "all",
      reason: "DM — delete all (revoke)",
    };
  }

  if (entity instanceof Api.Chat) {
    const admin = isAdmin(entity);
    return {
      ...base,
      title: entity.title || "Unknown Group",
      type: "group",
      is_admin: admin,
      mode: admin ? "all" : "mine",
      reason: admin ? "basic group, admin — delete all" : "basic group, not admin — mine only",
    };
  }

  if (entity instanceof Api.Channel) {
    if (entity.megagroup) {
      const admin = isAdmin(entity);
      return {
        ...base,
        title: entity.title || "Unknown",
        type: "group",
        is_admin: admin,
        mode: admin ? "all" : "mine",
        reason: admin ? "supergroup, admin — delete all" : "supergroup, not admin — mine only",
      };
    }
    return {
      ...base,
      title: entity.title || "Unknown",
      type: "channel",
      is_admin: isAdmin(entity),
      mode: "skip",
      reason: "broadcast channel — skipped per config",
    };
  }

  return null;
}

/**
 * Cheap pass: dialog list -> classified chats with filters applied.
 * No message fetching here; counts are done separately per chat.
 */
export async function enumerateChats(
  client: TelegramClient,
  filters: ChatFilters = {},
  dialogLimit = 1000
): Promise<ClassifiedChat[]> {
  const dialogs = await client.getDialogs({ limit: dialogLimit });
  const selfId = await getSelfId(client);
  const out: ClassifiedChat[] = [];

  for (const dialog of dialogs) {
    const c = classify(dialog, selfId);
    if (!c) continue;
    if (filters.allowedChatIds && !filters.allowedChatIds.has(c.raw_id)) continue;
    if (filters.exclude?.some((h) => matchesHandle(c, h))) continue;
    if (filters.include?.length && !filters.include.some((h) => matchesHandle(c, h)))
      continue;
    out.push(c);
  }
  return out;
}

export interface OldMessageStats {
  count: number;
  oldest: string | null;
  newest: string | null;
  sample_ids: number[];
}

/**
 * Count messages older than the cutoff that match the chat's delete mode,
 * excluding pinned. Informational for the dry-run plan only — --apply
 * re-fetches ids at delete time.
 */
export async function countOldMessages(
  client: TelegramClient,
  chat: ClassifiedChat,
  cutoffEpoch: number
): Promise<OldMessageStats> {
  if (chat.mode === "skip") return { count: 0, oldest: null, newest: null, sample_ids: [] };

  const params: any = { offsetDate: cutoffEpoch };
  if (chat.mode === "mine") params.fromUser = "me";

  let count = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  const sample_ids: number[] = [];

  for await (const msg of client.iterMessages(chat.entity, params)) {
    if (!msg || (msg as any).pinned) continue;
    count++;
    const ts = (msg as any).date as number;
    if (newest === null || ts > newest) newest = ts;
    if (oldest === null || ts < oldest) oldest = ts;
    if (sample_ids.length < 5) sample_ids.push(msg.id);
  }
  await sleep(150);

  return {
    count,
    oldest: oldest ? new Date(oldest * 1000).toISOString() : null,
    newest: newest ? new Date(newest * 1000).toISOString() : null,
    sample_ids,
  };
}
