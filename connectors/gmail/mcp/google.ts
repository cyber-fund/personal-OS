/**
 * Google Workspace pure helpers — scopes, response parsers, and request builders.
 *
 * Kept free of I/O and of the MCP server bootstrap so they can be unit-tested
 * directly (server.ts self-starts a transport on import).
 */

/**
 * OAuth scopes the Google connector requests. The refresh token must be minted
 * with these scopes — if you add a scope here, the user must re-run the OAuth
 * flow (the existing token will not have the new permission).
 *
 * `calendar.events` grants read + write on events (covers listing too).
 */
export const WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/presentations.readonly",
  // Docs/Sheets/Slides are read by explicit file ID (from the share URL), so no
  // Drive scope is needed — the per-app read-only scopes above are sufficient.
] as const;

// --- Google Docs ---

/** Flatten a Docs `documents.get` response to plain text. */
export function extractDocText(doc: any): string {
  const content = doc?.body?.content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const el of content) {
    const elements = el?.paragraph?.elements;
    if (!Array.isArray(elements)) continue;
    let line = "";
    for (const e of elements) {
      const t = e?.textRun?.content;
      if (typeof t === "string") line += t;
    }
    out.push(line);
  }
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

// --- Google Sheets ---

/** Render a `spreadsheets.values.get` response as tab-separated rows. */
export function extractSheetText(valueRange: any): string {
  const values = valueRange?.values;
  if (!Array.isArray(values)) return "";
  return values
    .map((row: unknown[]) => (Array.isArray(row) ? row.map((c) => String(c ?? "")).join("\t") : ""))
    .join("\n")
    .trim();
}

// --- Google Slides ---

/** Concatenate all text from a `presentations.get` response, one block per slide. */
export function extractSlidesText(presentation: any): string {
  const slides = presentation?.slides;
  if (!Array.isArray(slides)) return "";
  const out: string[] = [];
  slides.forEach((slide: any, i: number) => {
    const parts: string[] = [];
    for (const pe of slide?.pageElements ?? []) {
      const textElements = pe?.shape?.text?.textElements;
      if (!Array.isArray(textElements)) continue;
      for (const te of textElements) {
        const t = te?.textRun?.content;
        if (typeof t === "string") parts.push(t);
      }
    }
    const text = parts.join("").trim();
    if (text) out.push(`## Slide ${i + 1}\n${text}`);
  });
  return out.join("\n\n").trim();
}

// --- Calendar event ---

export interface CalendarEventArgs {
  summary: string;
  start: string; // ISO datetime ("2026-07-01T15:00:00") or date ("2026-07-01")
  end: string;
  description?: string;
  location?: string;
  attendees?: string[]; // email addresses
  timeZone?: string;
}

function asTimePoint(value: string, timeZone?: string): Record<string, string> {
  // A bare YYYY-MM-DD is an all-day point; anything else is a dateTime.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  const point: Record<string, string> = { dateTime: value };
  if (timeZone) point.timeZone = timeZone;
  return point;
}

/** Build the Calendar `events.insert` request body. */
export function buildCalendarEventBody(args: CalendarEventArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: args.summary,
    start: asTimePoint(args.start, args.timeZone),
    end: asTimePoint(args.end, args.timeZone),
  };
  if (args.description) body.description = args.description;
  if (args.location) body.location = args.location;
  if (args.attendees && args.attendees.length > 0) {
    body.attendees = args.attendees.map((email) => ({ email }));
  }
  return body;
}
