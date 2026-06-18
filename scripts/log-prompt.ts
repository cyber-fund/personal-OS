#!/usr/bin/env bun
/**
 * UserPromptSubmit hook — logs every user message to vault sessions folder.
 * Receives user input via stdin.
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { isSetupComplete, resolveVaultPath, formatMMDD, formatYY, formatTime, formatISO } from "../connectors/_shared/vault";

// Read user input from stdin
let input = "";
try {
  input = readFileSync("/dev/stdin", "utf-8").trim();
} catch {
  process.exit(0);
}

if (!input || !isSetupComplete()) process.exit(0);

const now = new Date();
const sessionsDir = resolveVaultPath("private", "context", "sessions");
mkdirSync(sessionsDir, { recursive: true });

const sessionFile = `${sessionsDir}/${formatMMDD(now)}-session-${formatYY(now)}.md`;

// Create file with header if it doesn't exist
if (!existsSync(sessionFile)) {
  appendFileSync(
    sessionFile,
    `---
date: ${formatISO(now)}
type: session-log
---

# Session Log — ${formatISO(now)}

`
  );
}

// Append the user prompt with timestamp
appendFileSync(sessionFile, `## ${formatTime(now)} | user\n${input}\n\n`);

// Output JSON for Claude Code hook runner:
// - systemMessage → displayed to the user in the console
const hookOutput = {
  systemMessage: `[session] logged to ${formatMMDD(now)}-session-${formatYY(now)}.md`,
};
console.log(JSON.stringify(hookOutput));
