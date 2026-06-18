/**
 * Keychain Gatekeeper
 *
 * All secret access from connectors goes through this module.
 * Flow:
 * 1. Check approval-store.json for recent Touch ID approval
 * 2. If expired (>24h): trigger Touch ID via Swift helper
 * 3. Read secret from macOS Keychain
 * 4. Log the access
 * 5. Return the value
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const HOME = homedir();
const CONFIG_DIR = join(HOME, ".cyboslite");
const SECRETS_DIR = join(CONFIG_DIR, "secrets");
const APPROVAL_STORE = join(SECRETS_DIR, "approval-store.json");
const ACCESS_LOG = join(SECRETS_DIR, "access.log");
const MANIFEST = join(SECRETS_DIR, "manifest.json");
const TOUCH_ID_BINARY = join(import.meta.dir, "touch-id", "touch-id-helper");

const APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export class ApprovalDeniedError extends Error {
  constructor(connector: string) {
    super(`Touch ID approval denied for connector: ${connector}`);
    this.name = "ApprovalDeniedError";
  }
}

export class SecretNotFoundError extends Error {
  constructor(connector: string, key: string) {
    super(`Secret not found in Keychain: cybos.${connector} / ${key}`);
    this.name = "SecretNotFoundError";
  }
}

interface ApprovalEntry {
  last_touch_id: string;
  approved_keys: string[];
}

interface ApprovalStore {
  [connector: string]: ApprovalEntry;
}

export interface KeychainGateOptions {
  connector: string;
  key: string;
  caller: "mcp" | "collect";
}

/**
 * Read a secret from Keychain with Touch ID gating
 */
export async function getSecret(options: KeychainGateOptions): Promise<string> {
  const { connector, key, caller } = options;

  mkdirSync(SECRETS_DIR, { recursive: true });

  // Step 1: Check approval store
  const approved = await checkApproval(connector);

  // Step 2: If not approved, request Touch ID
  if (!approved) {
    await requestTouchID(connector);
  }

  // Step 3: Read from Keychain
  const value = readFromKeychain(connector, key);

  // Step 4: Log the access
  logAccess(connector, key, caller);

  return value;
}

/**
 * Store a secret in Keychain (called by setup, not by Claude)
 *
 * Touch ID / biometric gating is enforced at the application level by
 * keychain-gate.ts (getSecret), not by macOS keychain ACLs.
 * We do NOT use `-T ""` because it causes a keychain password prompt on
 * every access, which breaks automated collection flows.
 */
export function storeSecret(connector: string, key: string, value: string): void {
  const service = `cybos.${connector}`;

  // Delete existing entry first (ignore errors if not found)
  spawnSync("security", ["delete-generic-password", "-s", service, "-a", key], {
    stdio: "ignore",
  });

  // Add new entry
  const args = ["add-generic-password", "-s", service, "-a", key, "-w", value, "-U"];
  const result = spawnSync("security", args, { stdio: "pipe" });

  if (result.status !== 0) {
    throw new Error(
      `Failed to store secret in Keychain: ${result.stderr?.toString()}`
    );
  }

  // Update manifest
  updateManifest(connector, key);
}

/**
 * Check if connector has recent Touch ID approval
 */
async function checkApproval(connector: string): Promise<boolean> {
  if (!existsSync(APPROVAL_STORE)) return false;

  try {
    const store: ApprovalStore = JSON.parse(readFileSync(APPROVAL_STORE, "utf-8"));
    const entry = store[connector];
    if (!entry?.last_touch_id) return false;

    const lastApproval = new Date(entry.last_touch_id).getTime();
    const now = Date.now();
    return now - lastApproval < APPROVAL_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Request Touch ID approval via Swift helper
 */
async function requestTouchID(connector: string): Promise<void> {
  // Check if Touch ID binary exists
  if (!existsSync(TOUCH_ID_BINARY)) {
    console.warn(
      "Touch ID helper not compiled. Falling back to always-approved mode."
    );
    console.warn("Run: bash connectors/_shared/touch-id/build.sh");
    updateApprovalStore(connector);
    return;
  }

  const result = spawnSync(TOUCH_ID_BINARY, [`personal-OS: approve ${connector} connector`], {
    stdio: "inherit",
  });

  switch (result.status) {
    case 0:
      // Approved
      updateApprovalStore(connector);
      break;
    case 1:
      // Biometry not available — fall back to always-approved
      console.warn("Touch ID not available — approving without biometric check");
      updateApprovalStore(connector);
      break;
    case 2:
      // Denied
      throw new ApprovalDeniedError(connector);
    default:
      console.warn(`Touch ID helper returned unexpected code: ${result.status}`);
      updateApprovalStore(connector);
  }
}

/**
 * Update approval store with current timestamp
 */
function updateApprovalStore(connector: string): void {
  let store: ApprovalStore = {};
  if (existsSync(APPROVAL_STORE)) {
    try {
      store = JSON.parse(readFileSync(APPROVAL_STORE, "utf-8"));
    } catch { /* start fresh */ }
  }

  store[connector] = {
    last_touch_id: new Date().toISOString(),
    approved_keys: store[connector]?.approved_keys ?? [],
  };

  writeFileSync(APPROVAL_STORE, JSON.stringify(store, null, 2));
}

/**
 * Read a secret from Keychain WITHOUT Touch ID gating.
 * Use for secrets that should be accessible without biometric approval
 * (e.g. API keys that are not security-critical enough to warrant daily approval).
 * Returns null if the secret is not found.
 */
export function getSecretUngated(connector: string, key: string, caller: "mcp" | "collect" = "collect"): string | null {
  const service = `cybos.${connector}`;
  const result = spawnSync(
    "security",
    ["find-generic-password", "-s", service, "-a", key, "-w"],
    { stdio: "pipe" }
  );

  if (result.status !== 0) return null;

  const value = result.stdout.toString().trim();
  logAccess(connector, key, caller);
  return value;
}

/**
 * Check if a secret exists in Keychain without retrieving its value.
 * Does NOT trigger Touch ID gating.
 */
export function secretExists(connector: string, key: string): boolean {
  const service = `cybos.${connector}`;
  const result = spawnSync(
    "security",
    ["find-generic-password", "-s", service, "-a", key],
    { stdio: "ignore" }
  );
  return result.status === 0;
}

/**
 * Read a secret value from macOS Keychain
 */
function readFromKeychain(connector: string, key: string): string {
  const service = `cybos.${connector}`;

  const result = spawnSync(
    "security",
    ["find-generic-password", "-s", service, "-a", key, "-w"],
    { stdio: "pipe" }
  );

  if (result.status !== 0) {
    throw new SecretNotFoundError(connector, key);
  }

  return result.stdout.toString().trim();
}

/**
 * Log a Keychain access to the append-only access log
 */
function logAccess(connector: string, key: string, caller: string): void {
  const timestamp = new Date().toISOString();
  const pid = process.pid;
  const entry = `${timestamp} | ${connector.padEnd(10)} | ${key.padEnd(25)} | ${caller.padEnd(7)} | pid:${pid}\n`;

  mkdirSync(SECRETS_DIR, { recursive: true });
  appendFileSync(ACCESS_LOG, entry);
}

/**
 * Update the secrets manifest (key names only, never values)
 */
function updateManifest(connector: string, key: string): void {
  mkdirSync(SECRETS_DIR, { recursive: true });
  let manifest: Record<string, any> = {};
  if (existsSync(MANIFEST)) {
    try {
      manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
    } catch { /* start fresh */ }
  }

  if (!manifest[connector]) {
    manifest[connector] = {
      keys: [],
      keychain_service: `cybos.${connector}`,
      added: new Date().toISOString().slice(0, 10),
    };
  }

  if (!manifest[connector].keys.includes(key)) {
    manifest[connector].keys.push(key);
  }

  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
}
