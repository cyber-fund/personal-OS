#!/usr/bin/env bun
/**
 * Telegram interactive authentication (CLI fallback)
 *
 * The setup wizard runs auth in-browser. This CLI is only for re-auth or
 * power-user scenarios.
 *
 *   bun connectors/telegram/auth.ts
 *
 * Reads TELEGRAM_API_ID / TELEGRAM_API_HASH from Keychain.
 * Stores TELEGRAM_SESSION in Keychain on success.
 */

import * as readline from "readline";
import { createClient, saveSession, hasSession } from "./core/client";

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function main() {
  console.log("personal-OS — Telegram authentication\n");

  if (hasSession()) {
    const overwrite = await prompt("A session already exists. Re-authenticate? (y/N): ");
    if (overwrite.toLowerCase() !== "y") {
      console.log("Cancelled.");
      process.exit(0);
    }
  }

  const client = await createClient({ caller: "auth" });

  await client.start({
    phoneNumber: () => prompt("Phone number (with country code): "),
    password: () => prompt("2FA password (if set): "),
    phoneCode: () => prompt("Code received: "),
    onError: (err) => console.error("Auth error:", err.message),
  });

  const sessionString = client.session.save() as unknown as string;
  saveSession(sessionString);

  console.log("\nAuthentication successful. Session saved.");
  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
