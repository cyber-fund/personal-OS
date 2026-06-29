/**
 * Slack pure helpers — formatting + request building, no I/O.
 * Kept separate from server.ts (which self-starts a transport) for unit testing.
 */

export const SLACK_API_BASE = "https://slack.com/api";

export interface SlackChannel {
  id: string;
  name?: string;
  is_private?: boolean;
  is_member?: boolean;
}

export interface SlackMessage {
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
}

/** Render a channel list as markdown bullets. */
export function formatChannels(channels: SlackChannel[]): string {
  if (!channels.length) return "No channels found.";
  return channels
    .map((c) => {
      const lock = c.is_private ? "🔒" : "#";
      const member = c.is_member === false ? " (not a member)" : "";
      return `- ${lock}${c.name ?? "(unnamed)"} — id: ${c.id}${member}`;
    })
    .join("\n");
}

/** Render messages oldest→newest, resolving user ids to names when a map is given. */
export function formatMessages(messages: SlackMessage[], userNames: Record<string, string> = {}): string {
  if (!messages.length) return "No messages.";
  return [...messages]
    .reverse()
    .map((m) => {
      const who = m.user ? userNames[m.user] ?? m.user : "unknown";
      const text = (m.text ?? "").trim();
      const thread = m.reply_count ? ` [${m.reply_count} repl${m.reply_count === 1 ? "y" : "ies"}, ts: ${m.ts}]` : "";
      return `**${who}**${thread}: ${text}`;
    })
    .join("\n");
}

/** Build the chat.postMessage payload. */
export function buildPostBody(channel: string, text: string, threadTs?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { channel, text };
  if (threadTs) body.thread_ts = threadTs;
  return body;
}
