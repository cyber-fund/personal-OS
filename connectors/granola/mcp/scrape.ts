/**
 * Granola local-cache scraper — the no-API-key fallback.
 *
 * Granola stores meetings in a local cache on disk:
 *   ~/Library/Application Support/Granola/cache-v6.json.enc
 * Despite the `.enc` suffix this is plain JSON: the real state is usually a
 * stringified JSON blob under the top-level `cache` key.
 *
 * ⚠ UNSTABLE: this reads an undocumented, internal Granola file format. Granola
 * can change the schema or filename in any update and break this scraper. It is
 * offered as a fallback for users without a paid Granola API key. If it stops
 * returning meetings, the cache format likely changed — update parseGranolaCache.
 *
 * No secret is required: this reads local files only.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type {
  GranolaNoteDetail,
  GranolaNoteListItem,
  GranolaTranscriptSegment,
} from "./types";

const DEFAULT_CACHE_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "Granola",
  "cache-v6.json.enc"
);

/** Resolve the cache path (env override wins; null if nothing readable). */
export function findCachePath(): string | null {
  const override = process.env.GRANOLA_CACHE_PATH;
  if (override) return existsSync(override) ? override : null;
  return existsSync(DEFAULT_CACHE_PATH) ? DEFAULT_CACHE_PATH : null;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return undefined;
}

function extractTranscript(raw: unknown): GranolaTranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((seg: any) => ({
      text: firstString(seg?.text, seg?.value, seg?.content) ?? "",
      source: firstString(seg?.source, seg?.speaker, seg?.channel),
      start_timestamp:
        typeof seg?.start_timestamp === "number" ? seg.start_timestamp : undefined,
      end_timestamp:
        typeof seg?.end_timestamp === "number" ? seg.end_timestamp : undefined,
    }))
    .filter((s) => s.text.length > 0);
}

function extractPeople(doc: any): Array<{ name?: string; email?: string }> {
  const raw =
    doc?.people ??
    doc?.attendees ??
    doc?.calendar_event?.attendees ??
    doc?.google_calendar_event?.attendees ??
    [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p: any) => ({
      name: firstString(p?.name, p?.displayName, p?.display_name),
      email: firstString(p?.email),
    }))
    .filter((p) => p.name || p.email);
}

/**
 * Parse the raw cache file contents into a list of meeting details.
 * Pure function (no I/O) so it is unit-testable against fixtures.
 */
export function parseGranolaCache(raw: string): GranolaNoteDetail[] {
  let root: any;
  try {
    root = JSON.parse(raw);
  } catch {
    throw new Error("Granola cache is not valid JSON (format may have changed)");
  }

  // The real state is often a stringified JSON blob under `cache`.
  if (root && typeof root.cache === "string") {
    try {
      root = JSON.parse(root.cache);
    } catch {
      /* fall back to root as-is */
    }
  }

  const state = root?.state ?? root ?? {};

  const docsRaw = state.documents ?? state.notes ?? state.meetings ?? {};
  const docs: any[] = Array.isArray(docsRaw) ? docsRaw : Object.values(docsRaw);

  const transcriptsMap: Record<string, unknown> =
    state.transcripts ?? state.transcript ?? {};

  const results: GranolaNoteDetail[] = [];

  for (const doc of docs) {
    if (!doc || typeof doc !== "object") continue;
    const id = firstString(doc.id, doc.document_id, doc.note_id);
    if (!id) continue;

    const title = firstString(doc.title, doc.name) ?? "Untitled meeting";
    const created_at =
      firstString(doc.created_at, doc.created, doc.createdAt) ??
      firstString(doc.updated_at, doc.updatedAt) ??
      "";
    const updated_at = firstString(doc.updated_at, doc.updatedAt);

    const transcript = extractTranscript(
      transcriptsMap[id] ?? doc.transcript ?? doc.transcript_segments
    );

    const summary = firstString(
      doc.notes_markdown,
      doc.summary,
      doc.ai_summary,
      doc.notes_plain,
      doc.overview
    );

    results.push({
      id,
      title,
      created_at,
      updated_at,
      summary,
      transcript,
      people: extractPeople(doc),
    });
  }

  return results;
}

function readAllNotes(): GranolaNoteDetail[] {
  const path = findCachePath();
  if (!path) {
    throw new Error(
      `Granola cache not found (looked at ${process.env.GRANOLA_CACHE_PATH ?? DEFAULT_CACHE_PATH}). ` +
        `Open Granola at least once, or set GRANOLA_API_KEY to use the API instead.`
    );
  }
  return parseGranolaCache(readFileSync(path, "utf-8"));
}

/** List notes (scrape mode), optionally filtered to those created after an ISO timestamp. */
export function scrapeListNotes(createdAfter?: string): GranolaNoteListItem[] {
  const notes = readAllNotes();
  const cutoff = createdAfter ? Date.parse(createdAfter) : NaN;
  return notes
    .filter((n) => {
      if (Number.isNaN(cutoff)) return true;
      const t = Date.parse(n.created_at);
      return Number.isNaN(t) ? true : t >= cutoff;
    })
    .map((n) => ({
      id: n.id,
      title: n.title,
      created_at: n.created_at,
      updated_at: n.updated_at,
    }));
}

/** Get a single note's detail by id (scrape mode). */
export function scrapeGetNote(noteId: string): GranolaNoteDetail | null {
  return readAllNotes().find((n) => n.id === noteId) ?? null;
}
