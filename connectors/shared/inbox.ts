/**
 * Shared daily inbox writer.
 * Connectors call appendToInbox() during --collect to aggregate
 * new/delta content into vault/content/inbox/YYYY-MM-DD.md.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { resolveVaultPath } from "../_shared/vault";

export function getInboxPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  const dir = resolveVaultPath("content", "inbox");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${date}.md`);
}

/**
 * Append a section to the daily inbox file.
 * @param section  Section heading, e.g. "Telegram", "Email", "Meetings", "Twitter"
 * @param content  Pre-formatted markdown content for that section
 */
export function appendToInbox(section: string, content: string): void {
  const path = getInboxPath();
  const time = new Date().toISOString().slice(11, 16);
  const header = `\n## ${section} (${time} sync)\n\n`;

  if (!existsSync(path)) {
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(path, `# Inbox — ${date}\n`);
  }

  const existing = readFileSync(path, "utf-8");
  writeFileSync(path, existing + header + content + "\n");
}
