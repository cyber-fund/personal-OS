/**
 * Telegram dialog and message operations
 */

import { TelegramClient, Api } from "telegram";

export interface DialogInfo {
  id: string;
  title: string;
  type: "private" | "group" | "channel";
  unreadCount: number;
  lastMessageDate: Date;
  entity: Api.TypeInputPeer;
  username?: string;
}

export interface MessageInfo {
  id: number;
  date: Date;
  sender: string;
  senderId?: string;
  text: string;
  isOutgoing: boolean;
}

function isMuted(dialog: any): boolean {
  const muteUntil = dialog.dialog?.notifySettings?.muteUntil;
  if (!muteUntil || muteUntil === 0) return false;
  return muteUntil > Math.floor(Date.now() / 1000);
}

function dialogToInfo(dialog: any, isRequest: boolean = false): DialogInfo | null {
  const entity = dialog.entity;
  let dialogType: "private" | "group" | "channel" = "private";
  let title = dialog.title || "Unknown";
  let username: string | undefined;

  if (entity instanceof Api.User) {
    dialogType = "private";
    title = [entity.firstName, entity.lastName].filter(Boolean).join(" ") || entity.username || "Unknown";
    username = entity.username;
  } else if (entity instanceof Api.Chat) {
    dialogType = "group";
    title = entity.title || "Unknown Group";
  } else if (entity instanceof Api.Channel) {
    dialogType = entity.megagroup ? "group" : "channel";
    title = entity.title || "Unknown Channel";
    username = entity.username;
  } else {
    return null;
  }

  return {
    id: dialog.id!.toString(),
    title,
    type: dialogType,
    unreadCount: dialog.unreadCount,
    lastMessageDate: dialog.date ? new Date(dialog.date * 1000) : new Date(),
    entity: dialog.inputEntity!,
    username,
  };
}

export async function getUnreadDialogs(
  client: TelegramClient,
  maxCount: number,
  options: { includeRequests?: boolean } = {}
): Promise<DialogInfo[]> {
  const dialogs = await client.getDialogs({ limit: 100, archived: false });
  const result: DialogInfo[] = [];

  for (const dialog of dialogs) {
    const hasUnreadMark = (dialog.dialog as any)?.unreadMark === true;
    if (dialog.unreadCount <= 0 && !hasUnreadMark) continue;
    if (dialog.archived || (dialog as any).folderId === 1) continue;
    if (isMuted(dialog)) continue;

    const entity = dialog.entity;
    const isRequest =
      entity instanceof Api.User &&
      (entity.contact === false || entity.contact === undefined);

    if (options.includeRequests) {
      if (!isRequest) continue;
    } else {
      if (isRequest && entity instanceof Api.User) continue;
    }

    const info = dialogToInfo(dialog);
    if (info) result.push(info);
  }

  result.sort((a, b) => b.lastMessageDate.getTime() - a.lastMessageDate.getTime());
  return result.slice(0, maxCount);
}

/**
 * Fetch the dialog list once (for batch operations like --collect).
 * Returns raw GramJS dialog objects for use with matchDialogFromList.
 */
export async function getDialogList(client: TelegramClient, limit: number = 200): Promise<DialogInfo[]> {
  const dialogs = await client.getDialogs({ limit });
  const result: DialogInfo[] = [];
  for (const dialog of dialogs) {
    const info = dialogToInfo(dialog);
    if (info) result.push(info);
  }
  return result;
}

/**
 * Match a query against a pre-fetched dialog list (no API call).
 */
export function matchDialogFromList(dialogs: DialogInfo[], query: string): DialogInfo | null {
  const searchLower = query.toLowerCase().replace("@", "");
  for (const d of dialogs) {
    const titleMatch = d.title.toLowerCase().includes(searchLower);
    const usernameMatch = d.username?.toLowerCase().includes(searchLower);
    if (titleMatch || usernameMatch) return d;
  }
  return null;
}

export async function searchDialogs(
  client: TelegramClient,
  query: string,
  limit: number = 200
): Promise<DialogInfo[]> {
  const searchLower = query.toLowerCase().replace("@", "");
  const dialogs = await client.getDialogs({ limit });
  const matches: DialogInfo[] = [];

  for (const dialog of dialogs) {
    const entity = dialog.entity;
    let matched = false;

    if (entity instanceof Api.User) {
      const fullName = [entity.firstName, entity.lastName].filter(Boolean).join(" ").toLowerCase();
      const usernameMatch = entity.username?.toLowerCase().includes(searchLower);
      if (usernameMatch || fullName.includes(searchLower)) matched = true;
    } else if (entity instanceof Api.Chat || entity instanceof Api.Channel) {
      const title = (entity as any).title?.toLowerCase() || "";
      const username = (entity as any).username?.toLowerCase() || "";
      if (title.includes(searchLower) || username.includes(searchLower)) matched = true;
    }

    if (matched) {
      const info = dialogToInfo(dialog);
      if (info) matches.push(info);
    }
  }

  // If nothing found and query starts with @, try direct username resolution
  if (matches.length === 0 && (query.startsWith("@") || /^[a-zA-Z][a-zA-Z0-9_]{3,}$/.test(query))) {
    try {
      const username = query.replace("@", "");
      const result = await client.invoke(new Api.contacts.ResolveUsername({ username }));
      if (result.users.length > 0) {
        const user = result.users[0] as Api.User;
        const title = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || "Unknown";
        matches.push({
          id: user.id.toString(),
          title,
          type: "private",
          unreadCount: 0,
          lastMessageDate: new Date(),
          entity: new Api.InputPeerUser({ userId: user.id, accessHash: user.accessHash || BigInt(0) }),
          username: user.username,
        });
      }
    } catch {
      // Resolution failed
    }
  }

  return matches;
}

function messageToInfo(msg: any): MessageInfo {
  let sender = "Unknown";
  let senderId: string | undefined;

  if (msg.sender instanceof Api.User) {
    sender = [msg.sender.firstName, msg.sender.lastName].filter(Boolean).join(" ") || msg.sender.username || "Unknown";
    senderId = msg.sender.id.toString();
  } else if (msg.sender instanceof Api.Channel || msg.sender instanceof Api.Chat) {
    sender = (msg.sender as any).title || "Channel";
    senderId = msg.sender.id.toString();
  }

  return {
    id: msg.id,
    date: new Date(msg.date * 1000),
    sender,
    senderId,
    text: msg.message || "",
    isOutgoing: msg.out || false,
  };
}

/**
 * Fetch all messages newer than `minId`, paginated. Caps at maxBatches * 100
 * messages as a safety bound (default 500).
 */
export async function getMessagesSince(
  client: TelegramClient,
  entity: Api.TypeInputPeer,
  minId: number,
  maxBatches: number = 5
): Promise<MessageInfo[]> {
  const all: MessageInfo[] = [];
  const BATCH_SIZE = 100;
  let offsetId = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    const params: any = { limit: BATCH_SIZE, minId };
    if (offsetId > 0) params.offsetId = offsetId;

    const messages = await client.getMessages(entity, params);
    if (!messages || messages.length === 0) break;

    for (const msg of messages) all.push(messageToInfo(msg));

    if (messages.length < BATCH_SIZE) break;
    offsetId = messages[messages.length - 1].id;

    // Light rate limit between batches
    await new Promise((r) => setTimeout(r, 200));
  }

  return all.reverse(); // chronological (oldest first)
}

/**
 * Resolve a single entity by username or peer ID directly (fallback when
 * the entity is not in the pre-fetched dialog list).
 */
export async function resolveEntity(
  client: TelegramClient,
  query: { username?: string | null; title: string }
): Promise<DialogInfo | null> {
  try {
    const target = query.username ?? query.title;
    const entity = await client.getEntity(target);

    let dialogType: "private" | "group" | "channel" = "private";
    let title = "Unknown";
    let username: string | undefined;
    let inputPeer: Api.TypeInputPeer;

    if (entity instanceof Api.User) {
      dialogType = "private";
      title = [entity.firstName, entity.lastName].filter(Boolean).join(" ") || entity.username || "Unknown";
      username = entity.username;
      inputPeer = new Api.InputPeerUser({ userId: entity.id, accessHash: entity.accessHash || BigInt(0) });
    } else if (entity instanceof Api.Channel) {
      dialogType = entity.megagroup ? "group" : "channel";
      title = entity.title || "Unknown";
      username = entity.username;
      inputPeer = new Api.InputPeerChannel({ channelId: entity.id, accessHash: entity.accessHash || BigInt(0) });
    } else if (entity instanceof Api.Chat) {
      dialogType = "group";
      title = entity.title || "Unknown";
      inputPeer = new Api.InputPeerChat({ chatId: entity.id });
    } else {
      return null;
    }

    return {
      id: entity.id.toString(),
      title,
      type: dialogType,
      unreadCount: 0,
      lastMessageDate: new Date(),
      entity: inputPeer,
      username,
    };
  } catch {
    return null;
  }
}

export async function getMessages(
  client: TelegramClient,
  entity: Api.TypeInputPeer,
  limit: number
): Promise<MessageInfo[]> {
  const messages = await client.getMessages(entity, { limit });
  return messages.map(messageToInfo).reverse(); // chronological (oldest first)
}

export async function saveDraft(
  client: TelegramClient,
  peer: Api.TypeInputPeer,
  text: string
): Promise<void> {
  await client.invoke(new Api.messages.SaveDraft({ peer, message: text }));
}

// --- Folder operations ---

export interface FolderInfo {
  id: number;
  title: string;
  pinnedCount: number;
  includePeersCount: number;
  excludePeersCount: number;
  isChatlist: boolean;
}

function getFolderTitle(filter: any): string {
  // GramJS exposes title as either string or TextWithEntities
  if (typeof filter.title === "string") return filter.title;
  if (filter.title?.text) return filter.title.text;
  return `Folder ${filter.id}`;
}

export async function listFolders(client: TelegramClient): Promise<FolderInfo[]> {
  const filters = await client.invoke(new Api.messages.GetDialogFilters());
  // GramJS returns either an array directly or a wrapped object depending on version
  const list: any[] = Array.isArray(filters) ? filters : (filters as any).filters ?? [];

  const result: FolderInfo[] = [];
  for (const f of list) {
    if (f.className !== "DialogFilter" && f.className !== "DialogFilterChatlist") continue;
    result.push({
      id: f.id,
      title: getFolderTitle(f),
      pinnedCount: f.pinnedPeers?.length ?? 0,
      includePeersCount: f.includePeers?.length ?? 0,
      excludePeersCount: f.excludePeers?.length ?? 0,
      isChatlist: f.className === "DialogFilterChatlist",
    });
  }
  return result;
}

function findFolder(filters: any[], query: string): any | null {
  // Try numeric ID first
  const numId = parseInt(query, 10);
  if (!isNaN(numId)) {
    const byId = filters.find((f) => f.id === numId);
    if (byId) return byId;
  }
  // Match by title (case-insensitive substring)
  const lower = query.toLowerCase();
  return filters.find((f) => getFolderTitle(f).toLowerCase().includes(lower)) ?? null;
}

export interface FolderChat {
  id: string;
  title: string;
  type: "private" | "group" | "channel";
  username?: string;
}

async function inputPeerToInfo(client: TelegramClient, peer: any): Promise<FolderChat | null> {
  try {
    const entity = await client.getEntity(peer);
    if (entity instanceof Api.User) {
      return {
        id: entity.id.toString(),
        title: [entity.firstName, entity.lastName].filter(Boolean).join(" ") || entity.username || "Unknown",
        type: "private",
        username: entity.username,
      };
    } else if (entity instanceof Api.Channel) {
      return {
        id: entity.id.toString(),
        title: entity.title || "Unknown",
        type: entity.megagroup ? "group" : "channel",
        username: entity.username,
      };
    } else if (entity instanceof Api.Chat) {
      return {
        id: entity.id.toString(),
        title: entity.title || "Unknown",
        type: "group",
      };
    }
  } catch {
    return null;
  }
  return null;
}

export async function listFolderChats(
  client: TelegramClient,
  folderQuery: string
): Promise<{ folder: string; chats: FolderChat[] } | null> {
  const filters = await client.invoke(new Api.messages.GetDialogFilters());
  const list: any[] = Array.isArray(filters) ? filters : (filters as any).filters ?? [];
  const folder = findFolder(list, folderQuery);
  if (!folder) return null;

  const peers = [...(folder.pinnedPeers ?? []), ...(folder.includePeers ?? [])];
  const chats: FolderChat[] = [];
  for (const peer of peers) {
    const info = await inputPeerToInfo(client, peer);
    if (info) chats.push(info);
  }
  return { folder: getFolderTitle(folder), chats };
}
