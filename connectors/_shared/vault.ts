/**
 * Vault path resolution + file helpers
 * Shared by all connectors and scripts
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const HOME = homedir();
const CONFIG_DIR = join(HOME, ".cyboslite");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface CybosConfig {
  version: string;
  vault: {
    path: string;
    created: string;
  };
  setup_complete: boolean;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfig(): CybosConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

export function saveConfig(config: CybosConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function isSetupComplete(): boolean {
  const config = getConfig();
  return config?.setup_complete === true;
}

export function getVaultPath(): string {
  const config = getConfig();
  const raw = config?.vault?.path ?? "~/personal-OS-vault";
  return raw.replace("~", HOME);
}

export function resolveVaultPath(...segments: string[]): string {
  return join(getVaultPath(), ...segments);
}

export function ensureVaultDir(...segments: string[]): string {
  const dir = resolveVaultPath(...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readVaultFile(...segments: string[]): string | null {
  const path = resolveVaultPath(...segments);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function writeVaultFile(content: string, ...segments: string[]): void {
  const path = resolveVaultPath(...segments);
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content);
}

export function appendVaultFile(content: string, ...segments: string[]): void {
  const path = resolveVaultPath(...segments);
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  appendFileSync(path, content);
}

/**
 * Read and parse a .sync-state.json file from vault
 */
export function readSyncState(
  ...segments: string[]
): Record<string, any> | null {
  const content = readVaultFile(...segments, ".sync-state.json");
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write a .sync-state.json file to vault
 */
export function writeSyncState(
  state: Record<string, any>,
  ...segments: string[]
): void {
  writeVaultFile(JSON.stringify(state, null, 2), ...segments, ".sync-state.json");
}

/**
 * Date formatting utilities
 */
export function formatMMDD(date: Date = new Date()): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}${dd}`;
}

export function formatYY(date: Date = new Date()): string {
  return String(date.getFullYear()).slice(-2);
}

export function formatISO(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function formatTime(date: Date = new Date()): string {
  return date.toTimeString().slice(0, 5);
}

/**
 * Slug generation (handles Cyrillic)
 */
export function nameToSlug(name: string): string {
  const cyrillic: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh",
    з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
    п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
    ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
    я: "ya",
  };

  return name
    .toLowerCase()
    .split("")
    .map((c) => cyrillic[c] ?? c)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Create the full vault directory structure
 */
export function createVaultStructure(): void {
  const dirs = [
    "private/context",
    "private/context/telegram",
    "private/context/emails",
    "private/context/twitter",
    "private/context/calls",
    "private/context/sessions",
    "private/context/entities",
    "private/context/style",
    "private/workspace",
    "shared/projects",
    "shared/team",
  ];

  for (const dir of dirs) {
    ensureVaultDir(dir);
  }

  // Create ~/.cyboslite directories
  const configDirs = [
    join(CONFIG_DIR, "secrets"),
    join(CONFIG_DIR, "locks"),
    join(CONFIG_DIR, "logs"),
    join(CONFIG_DIR, "telegram"),
  ];

  for (const dir of configDirs) {
    mkdirSync(dir, { recursive: true });
  }
}
