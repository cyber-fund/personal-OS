/**
 * tg-cleanup — shared types, paths, run-id, signing, jsonl + duration helpers.
 *
 * Plan / audit / archive artifacts all live under one per-run directory in the
 * vault so a dropped run can be resumed from disk. See deliverables/requirements.md.
 */

import {
  existsSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { resolveVaultPath, nameToSlug } from "../../connectors/_shared/vault";

// --- domain types ---

export type ChatType = "private" | "group" | "channel";
export type DeleteMode = "all" | "mine" | "skip";

export interface ChatPlan {
  chat_id: string;
  title: string;
  type: ChatType;
  username: string | null;
  is_admin: boolean;
  mode: DeleteMode;
  reason: string; // why this mode (esp. for skip)
  count: number; // messages older than cutoff matching mode at dry-run time
  oldest: string | null; // ISO
  newest: string | null; // ISO
  sample_ids: number[];
}

export interface Plan {
  runId: string;
  created_at: string;
  expires_at: string;
  cutoff_epoch: number; // seconds
  older_than: string; // the raw flag value, e.g. "30d"
  chats: ChatPlan[];
  signature: string;
}

export interface EnumState {
  runId: string;
  status: "enumerating" | "complete";
  older_than: string;
  cutoff_epoch: number;
  created_at: string;
  updated_at: string;
}

// --- run id (date based, local time) ---

export function newRunId(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(
    d.getHours()
  )}${p(d.getMinutes())}`;
}

// --- paths ---

const PLAN_EXPIRY_MS = 12 * 60 * 60 * 1000; // 12h (decided 2026-06-15)

export function plansRoot(): string {
  return resolveVaultPath("private", "projects", "tg-cleanup", "plans");
}
export function planDir(runId: string): string {
  return join(plansRoot(), runId);
}
export function ensurePlanDir(runId: string): string {
  const dir = planDir(runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
export const planFile = (runId: string) => join(planDir(runId), "plan.json");
export const auditFile = (runId: string) => join(planDir(runId), "audit.jsonl");
export const enumCacheFile = (runId: string) =>
  join(planDir(runId), "enum-cache.jsonl");
export const stateFile = (runId: string) => join(planDir(runId), "state.json");
export const checkpointFile = (runId: string) =>
  join(planDir(runId), "checkpoint.json");
export function archiveDir(runId: string): string {
  const dir = join(planDir(runId), "archive");
  mkdirSync(dir, { recursive: true });
  return dir;
}
export const archiveFile = (runId: string, base: string) =>
  join(archiveDir(runId), `${base}.jsonl`);

/**
 * Readable, collision-safe archive filenames keyed by chat_id. Titles are
 * slugged (Cyrillic transliterated via nameToSlug); empty slugs fall back to
 * the id, and chats that slug to the same name get the id appended so the
 * mapping stays unique and deterministic across resumes.
 */
export function buildArchiveNames(
  chats: { chat_id: string; title: string }[]
): Map<string, string> {
  const slugOf = (c: { chat_id: string; title: string }) =>
    nameToSlug(c.title) || `chat-${c.chat_id}`;
  const freq = new Map<string, number>();
  for (const c of chats) freq.set(slugOf(c), (freq.get(slugOf(c)) ?? 0) + 1);
  const names = new Map<string, string>();
  for (const c of chats) {
    const s = slugOf(c);
    names.set(c.chat_id, (freq.get(s) ?? 0) > 1 ? `${s}-${c.chat_id}` : s);
  }
  return names;
}

export const PLAN_EXPIRY_HOURS = PLAN_EXPIRY_MS / 3_600_000;
export function expiryFrom(created: Date): string {
  return new Date(created.getTime() + PLAN_EXPIRY_MS).toISOString();
}

/** Most recent run dir whose state.json is still `enumerating`, or null. */
export function findIncompleteRun(): string | null {
  const root = plansRoot();
  if (!existsSync(root)) return null;
  const runs = readdirSync(root)
    .filter((name) => {
      const p = join(root, name);
      return existsSync(p) && statSync(p).isDirectory();
    })
    .sort()
    .reverse();
  for (const runId of runs) {
    const state = readJson<EnumState>(stateFile(runId));
    if (state?.status === "enumerating") return runId;
  }
  return null;
}

// --- duration parsing ---

/** Parse `Nd` / `Nmo` / `Ny` into a cutoff epoch (seconds) relative to now. */
export function parseOlderThan(raw: string, now: Date = new Date()): number {
  const m = raw.trim().match(/^(\d+)(d|mo|y)$/);
  if (!m) {
    throw new Error(
      `Invalid --older-than "${raw}". Use Nd / Nmo / Ny (e.g. 30d, 6mo, 1y).`
    );
  }
  const n = parseInt(m[1], 10);
  const days = m[2] === "d" ? n : m[2] === "mo" ? n * 30 : n * 365;
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  return Math.floor(cutoffMs / 1000);
}

// --- signing ---

/** sha256 over runId + cutoff + the (chat_id, mode) set, order-independent. */
export function signPlan(
  runId: string,
  cutoffEpoch: number,
  chats: ChatPlan[]
): string {
  const canon = chats
    .map((c) => ({ chat_id: c.chat_id, mode: c.mode }))
    .sort((a, b) => a.chat_id.localeCompare(b.chat_id));
  const payload = `${runId}|${cutoffEpoch}|${JSON.stringify(canon)}`;
  return createHash("sha256").update(payload).digest("hex");
}

// --- json / jsonl io ---

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function writeJson(path: string, obj: unknown): void {
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

export function appendJsonl(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify(obj) + "\n");
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // skip a torn final line from an interrupted write
    }
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
