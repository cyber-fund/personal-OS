#!/usr/bin/env bun
/**
 * Bulk sync Telegram folder chats to vault.
 *
 * Usage:
 *   bun scripts/sync-folders.ts 12 13 11
 *
 * Fetches all chats from the given folder IDs, reads 400 messages from each,
 * and saves them as individual .md files in vault/private/context/telegram/.
 */

import { createClient, connectAuthenticated, hasSession } from "../connectors/telegram/core/client";
import {
  listFolders,
  getMessages,
  type DialogInfo,
} from "../connectors/telegram/core/dialogs";
import { saveConversation } from "../connectors/telegram/core/conversation";
import { Api } from "telegram";

const MESSAGES_PER_CHAT = 400;
const DELAY_BETWEEN_CHATS_MS = 1000;

interface ResolvedChat {
  id: string;
  title: string;
  type: "private" | "group" | "channel";
  username?: string;
  entity: Api.TypeInputPeer;
}

/**
 * Resolve folder peers directly from the filter's peer list.
 * Uses client.getEntity(peer) which works for all peer types
 * including groups without usernames.
 */
async function getFolderPeers(client: any, folderId: number): Promise<ResolvedChat[]> {
  const filters = await client.invoke(new Api.messages.GetDialogFilters());
  const list: any[] = Array.isArray(filters) ? filters : (filters as any).filters ?? [];

  const folder = list.find((f: any) => f.id === folderId);
  if (!folder) return [];

  const rawPeers = [...(folder.pinnedPeers ?? []), ...(folder.includePeers ?? [])];
  const chats: ResolvedChat[] = [];

  for (const peer of rawPeers) {
    try {
      const entity = await client.getEntity(peer);

      if (entity instanceof Api.User) {
        chats.push({
          id: entity.id.toString(),
          title: [entity.firstName, entity.lastName].filter(Boolean).join(" ") || entity.username || "Unknown",
          type: "private",
          username: entity.username,
          entity: new Api.InputPeerUser({ userId: entity.id, accessHash: entity.accessHash || BigInt(0) }),
        });
      } else if (entity instanceof Api.Channel) {
        chats.push({
          id: entity.id.toString(),
          title: entity.title || "Unknown",
          type: entity.megagroup ? "group" : "channel",
          username: entity.username,
          entity: new Api.InputPeerChannel({ channelId: entity.id, accessHash: entity.accessHash || BigInt(0) }),
        });
      } else if (entity instanceof Api.Chat) {
        chats.push({
          id: entity.id.toString(),
          title: entity.title || "Unknown",
          type: "group",
          entity: new Api.InputPeerChat({ chatId: entity.id }),
        });
      }
    } catch {
      // Skip unresolvable peers
    }
  }

  return chats;
}

function getFolderTitle(filter: any): string {
  if (typeof filter.title === "string") return filter.title;
  if (filter.title?.text) return filter.title.text;
  return `Folder ${filter.id}`;
}

async function main() {
  const folderIds = process.argv.slice(2).map(Number).filter((n) => !isNaN(n));
  if (folderIds.length === 0) {
    console.error("Usage: bun scripts/sync-folders.ts <folder_id> [folder_id] ...");
    console.error("Example: bun scripts/sync-folders.ts 12 13 11");
    process.exit(1);
  }

  if (!hasSession()) {
    console.error("Telegram: not authenticated. Run setup wizard first.");
    process.exit(1);
  }

  const client = await createClient({ caller: "sync-folders", silent: true });

  try {
    await connectAuthenticated(client);
    console.log("Connected to Telegram.");

    // Get folder names for display
    const folders = await listFolders(client);
    const targetFolders = folderIds.map((id) => {
      const f = folders.find((f) => f.id === id);
      return f ? f.title : `Folder ${id}`;
    });
    console.log(`Syncing folders: ${targetFolders.join(", ")}`);

    // Collect all chats from all folders, resolved directly from peer objects
    const allChats: ResolvedChat[] = [];
    const seen = new Set<string>();

    for (const folderId of folderIds) {
      const chats = await getFolderPeers(client, folderId);
      for (const chat of chats) {
        if (!seen.has(chat.id)) {
          seen.add(chat.id);
          allChats.push(chat);
        }
      }
      console.log(`Folder ${folderId}: ${chats.length} chats resolved`);
      await new Promise((r) => setTimeout(r, 500));
    }

    console.log(`\nTotal unique chats: ${allChats.length}`);
    console.log("Starting sync...\n");

    let synced = 0;
    let failed = 0;

    for (const chat of allChats) {
      const label = chat.username ? `@${chat.username}` : chat.title;
      process.stdout.write(`[${synced + failed + 1}/${allChats.length}] ${label}... `);

      try {
        const messages = await getMessages(client, chat.entity, MESSAGES_PER_CHAT);

        // Build DialogInfo for saveConversation
        const dialogInfo: DialogInfo = {
          id: chat.id,
          title: chat.title,
          type: chat.type,
          unreadCount: 0,
          lastMessageDate: new Date(),
          entity: chat.entity,
          username: chat.username,
        };

        const result = saveConversation(dialogInfo, messages);
        console.log(`OK (${messages.length} msgs -> ${result.slug}.md)`);
        synced++;
      } catch (err: any) {
        console.log(`FAIL: ${err.message}`);
        failed++;
      }

      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_CHATS_MS));
    }

    console.log(`\nDone! ${synced} synced, ${failed} failed out of ${allChats.length} chats.`);
  } catch (err: any) {
    console.error("Fatal error:", err.message);
  } finally {
    await client.disconnect();
  }

  process.exit(0);
}

main();
