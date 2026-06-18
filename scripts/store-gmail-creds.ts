#!/usr/bin/env bun
/**
 * Store Gmail OAuth credentials in macOS Keychain.
 *
 * Usage:
 *   bun scripts/store-gmail-creds.ts <CLIENT_ID> <CLIENT_SECRET>
 *
 * After running this, start the server and complete the OAuth flow
 * to obtain and store the refresh token automatically.
 */

import { storeSecret } from "../connectors/_shared/keychain-gate";

const [clientId, clientSecret] = process.argv.slice(2);

if (!clientId || !clientSecret) {
  console.error("Usage: bun scripts/store-gmail-creds.ts <CLIENT_ID> <CLIENT_SECRET>");
  process.exit(1);
}

storeSecret("gmail", "GMAIL_CLIENT_ID", clientId);
storeSecret("gmail", "GMAIL_CLIENT_SECRET", clientSecret);

console.log("Gmail credentials stored in Keychain (cybos.gmail)");
console.log("Next: run 'bun scripts/server/index.ts' and complete OAuth in browser");
