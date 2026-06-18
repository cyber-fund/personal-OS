/**
 * Telegram client + session management
 *
 * All credentials (API_ID, API_HASH, SESSION) loaded from macOS Keychain
 * via the gatekeeper. Session is stored as TELEGRAM_SESSION secret.
 */

import { TelegramClient, Logger } from "telegram";
import { StringSession } from "telegram/sessions";
import { LogLevel } from "telegram/extensions/Logger";
import { getSecret, storeSecret, secretExists, SecretNotFoundError } from "../../_shared/keychain-gate";

const SESSION_KEY = "TELEGRAM_SESSION";

export async function loadSession(caller: "mcp" | "collect" | "auth" = "mcp"): Promise<string> {
  if (!secretExists("telegram", SESSION_KEY)) return "";
  try {
    return await getSecret({
      connector: "telegram",
      key: SESSION_KEY,
      caller: caller === "auth" ? "mcp" : caller,
    });
  } catch (err) {
    if (err instanceof SecretNotFoundError) return "";
    throw err;
  }
}

export function saveSession(session: string): void {
  storeSecret("telegram", SESSION_KEY, session);
}

export function hasSession(): boolean {
  return secretExists("telegram", SESSION_KEY);
}

export interface CreateClientOptions {
  caller: "mcp" | "collect" | "auth";
  silent?: boolean;
  initialSession?: string; // override session string (used during auth flow)
}

export async function createClient(opts: CreateClientOptions): Promise<TelegramClient> {
  const apiIdRaw = await getSecret({
    connector: "telegram",
    key: "TELEGRAM_API_ID",
    caller: opts.caller === "auth" ? "mcp" : opts.caller,
  });
  const apiHash = await getSecret({
    connector: "telegram",
    key: "TELEGRAM_API_HASH",
    caller: opts.caller === "auth" ? "mcp" : opts.caller,
  });

  const apiId = parseInt(apiIdRaw, 10);
  if (!apiId || !apiHash) {
    throw new Error("Telegram API credentials missing or invalid in Keychain");
  }

  const sessionString = opts.initialSession ?? (await loadSession(opts.caller));
  const session = new StringSession(sessionString);

  const clientOptions: any = { connectionRetries: 5 };
  if (opts.silent) {
    clientOptions.baseLogger = new Logger(LogLevel.NONE);
  }

  return new TelegramClient(session, apiId, apiHash, clientOptions);
}

/**
 * Connect and verify authentication. Throws if session is missing/invalid.
 */
export async function connectAuthenticated(client: TelegramClient): Promise<void> {
  await client.connect();
  if (!(await client.checkAuthorization())) {
    throw new Error(
      "Telegram session not authenticated. Re-run the personal-OS setup or auth flow."
    );
  }
}
