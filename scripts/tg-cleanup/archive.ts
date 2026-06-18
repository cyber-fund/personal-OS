/**
 * tg-cleanup — local message archive (text + metadata, no media bytes).
 *
 * Invariant enforced by the executor: a message is archived here BEFORE it is
 * deleted. One ChatArchive per chat; dedupes by msg_id across resumes.
 */

import { Api } from "telegram";
import { archiveFile, appendJsonl, readJsonl, ChatType } from "./shared";

export interface MediaDescriptor {
  type: string; // photo | video | voice | audio | document | sticker | ...
  filename: string | null;
  size: number | null;
  mime: string | null;
}

export interface ArchivedMessage {
  ts_archived: string;
  chat_id: string;
  chat_title: string;
  type: ChatType;
  msg_id: number;
  from_id: string | null;
  from_name: string | null;
  date: string; // ISO
  text: string;
  reply_to: number | null;
  fwd_from: string | null;
  pinned: boolean;
  media: MediaDescriptor | null;
}

function describeMedia(msg: any): MediaDescriptor | null {
  const media = msg.media;
  if (!media) return null;

  if (media instanceof Api.MessageMediaPhoto) {
    return { type: "photo", filename: null, size: null, mime: "image/jpeg" };
  }
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document as Api.Document | undefined;
    if (!doc || !(doc instanceof Api.Document)) {
      return { type: "document", filename: null, size: null, mime: null };
    }
    let type = "document";
    let filename: string | null = null;
    for (const attr of doc.attributes ?? []) {
      if (attr instanceof Api.DocumentAttributeFilename) filename = attr.fileName;
      else if (attr instanceof Api.DocumentAttributeAudio)
        type = attr.voice ? "voice" : "audio";
      else if (attr instanceof Api.DocumentAttributeVideo)
        type = attr.roundMessage ? "video_note" : "video";
      else if (attr instanceof Api.DocumentAttributeSticker) type = "sticker";
    }
    return {
      type,
      filename,
      size: typeof doc.size === "object" ? Number(doc.size) : (doc.size ?? null),
      mime: doc.mimeType ?? null,
    };
  }
  return { type: media.className ?? "other", filename: null, size: null, mime: null };
}

function peerId(peer: any): string | null {
  if (!peer) return null;
  const v = peer.userId ?? peer.channelId ?? peer.chatId;
  return v != null ? v.toString() : null;
}

function senderName(msg: any): string | null {
  const s = msg.sender;
  if (s instanceof Api.User) {
    return [s.firstName, s.lastName].filter(Boolean).join(" ") || s.username || null;
  }
  if (s instanceof Api.Channel || s instanceof Api.Chat) {
    return (s as any).title ?? null;
  }
  return null;
}

export function toArchived(
  msg: any,
  chat: { chat_id: string; title: string; type: ChatType }
): ArchivedMessage {
  return {
    ts_archived: new Date().toISOString(),
    chat_id: chat.chat_id,
    chat_title: chat.title,
    type: chat.type,
    msg_id: msg.id,
    from_id: peerId(msg.fromId),
    from_name: senderName(msg),
    date: new Date((msg.date as number) * 1000).toISOString(),
    text: msg.message ?? "",
    reply_to: msg.replyTo?.replyToMsgId ?? null,
    fwd_from: msg.fwdFrom ? peerId(msg.fwdFrom.fromId) : null,
    pinned: Boolean(msg.pinned),
    media: describeMedia(msg),
  };
}

export class ChatArchive {
  private seen: Set<number>;
  constructor(private runId: string, private fileBase: string) {
    this.seen = new Set(
      readJsonl<ArchivedMessage>(archiveFile(runId, fileBase)).map((m) => m.msg_id)
    );
  }

  /** Append messages not already archived. Returns how many were written. */
  write(messages: ArchivedMessage[]): number {
    let written = 0;
    for (const m of messages) {
      if (this.seen.has(m.msg_id)) continue;
      appendJsonl(archiveFile(this.runId, this.fileBase), m);
      this.seen.add(m.msg_id);
      written++;
    }
    return written;
  }
}
