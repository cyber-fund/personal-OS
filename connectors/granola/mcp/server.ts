#!/usr/bin/env bun
/**
 * Granola MCP Server — fetches meetings from Granola API and saves to vault.
 *
 * Auth: API key stored in macOS Keychain (cybos.granola / GRANOLA_API_KEY).
 *
 * Output: per-call directory in vault at private/context/calls/<date>_<slug>/
 *   - metadata.json
 *   - transcript.txt (if available)
 *   - notes.md (AI-generated summary)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { resolveVaultPath, ensureVaultDir, nameToSlug } from "../../_shared/vault";
import { appendToInbox } from "../../shared/inbox";
import { getSecretUngated } from "../../_shared/keychain-gate";

// --- Constants ---

const GRANOLA_API_BASE = "https://public-api.granola.ai/v1";

// --- Credentials ---

function getApiKey(): string | null {
  return getSecretUngated("granola", "GRANOLA_API_KEY", "mcp");
}

// --- Granola API helpers ---

async function granolaFetch(apiKey: string, path: string): Promise<any> {
  const res = await fetch(`${GRANOLA_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Granola API error ${res.status}: ${err}`);
  }

  return res.json();
}

interface GranolaNoteListItem {
  id: string;
  title: string;
  created_at: string;
  updated_at?: string;
}

interface GranolaNoteDetail {
  id: string;
  title: string;
  created_at: string;
  updated_at?: string;
  summary?: string;
  transcript?: Array<{
    text: string;
    source?: string;
    start_timestamp?: number;
    end_timestamp?: number;
  }>;
  people?: Array<{ name?: string; email?: string }>;
}

async function listNotes(apiKey: string, createdAfter?: string): Promise<GranolaNoteListItem[]> {
  const all: GranolaNoteListItem[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams();
    if (createdAfter) params.set("created_after", createdAfter);
    if (cursor) params.set("cursor", cursor);

    const queryStr = params.toString();
    const path = `/notes${queryStr ? `?${queryStr}` : ""}`;
    const data = await granolaFetch(apiKey, path);

    all.push(...(data.notes ?? []));
    cursor = data.hasMore ? data.cursor : undefined;
  } while (cursor);

  return all;
}

async function getNote(apiKey: string, noteId: string, includeTranscript: boolean = false): Promise<GranolaNoteDetail> {
  const params = includeTranscript ? "?include=transcript" : "";
  return granolaFetch(apiKey, `/notes/${noteId}${params}`);
}

// --- Vault helpers ---

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso.slice(0, 10);
  }
}

interface SavedCall {
  id: string;
  title: string;
  date: string;
  dirName: string;
  attendees: string[];
}

function updateIndex(outputBase: string, newCalls: SavedCall[]): void {
  const indexPath = join(outputBase, "INDEX.md");
  const existing: string[] = [];

  if (existsSync(indexPath)) {
    const content = readFileSync(indexPath, "utf-8");
    for (const line of content.split("\n")) {
      if (line.startsWith("| ") && !line.includes("----") && !line.includes("Date ")) {
        existing.push(line);
      }
    }
  }

  const newRows = newCalls.map(
    (c) => `| ${c.date} | ${c.title} | ${c.attendees.join(", ") || "—"} | [📁](./${c.dirName}/) |`
  );
  const allRows = [...existing, ...newRows].sort((a, b) => b.localeCompare(a));

  const md =
    `# Granola Calls Index\n\nLast updated: ${new Date().toISOString().slice(0, 16).replace("T", " ")}\n\n` +
    `| Date | Title | Attendees | Path |\n|------|-------|-----------|------|\n` +
    allRows.join("\n") +
    `\n\nTotal calls: ${allRows.length}\n`;

  writeFileSync(indexPath, md);
}

// --- --collect mode ---

if (process.argv.includes("--collect")) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log("Granola: no API key configured, skipping");
    console.log("0 calls extracted");
    process.exit(0);
  }

  try {
    // Fetch meetings from the last 30 days
    const createdAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const notes = await listNotes(apiKey, createdAfter);

    // Determine which are already saved
    const outputBase = resolveVaultPath("private", "context", "calls");
    const savedIds = new Set<string>();
    if (existsSync(outputBase)) {
      for (const entry of readdirSync(outputBase, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}_/.test(entry.name)) continue;
        const metaPath = join(outputBase, entry.name, "metadata.json");
        if (existsSync(metaPath)) {
          try {
            const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
            if (meta.id) savedIds.add(meta.id);
          } catch { /* skip malformed */ }
        }
      }
    }

    const newNotes = notes.filter((n) => !savedIds.has(n.id));
    if (newNotes.length === 0) {
      console.log(`Granola: ${notes.length} meetings, all already saved`);
      console.log("0 calls extracted");
      process.exit(0);
    }

    // Fetch details + transcripts and save each new note
    ensureVaultDir("private", "context", "calls");
    const savedCalls: SavedCall[] = [];
    const inboxEntries: string[] = [];

    for (const note of newNotes) {
      try {
        const detail = await getNote(apiKey, note.id, true);
        const dateStr = formatDate(detail.created_at);
        const slug = nameToSlug(detail.title);
        const dirName = `${dateStr}_${slug}`;
        const callDir = join(outputBase, dirName);

        if (existsSync(callDir)) continue;
        mkdirSync(callDir, { recursive: true });

        const attendeeList = (detail.people ?? [])
          .map((a) => a.name ?? a.email)
          .filter((n): n is string => !!n);

        // metadata.json
        writeFileSync(
          join(callDir, "metadata.json"),
          JSON.stringify(
            { id: detail.id, title: detail.title, date: detail.created_at, attendees: detail.people ?? [] },
            null,
            2
          )
        );

        // transcript.txt
        if (detail.transcript && detail.transcript.length > 0) {
          const transcriptText = detail.transcript
            .map((seg) => {
              const speaker = seg.source === "microphone" ? "You" : "Other";
              return `[${speaker}] ${seg.text}`;
            })
            .join("\n");
          writeFileSync(join(callDir, "transcript.txt"), transcriptText);
        }

        // notes.md
        if (detail.summary) {
          writeFileSync(join(callDir, "notes.md"), `# Summary\n\n${detail.summary}`);
        }

        savedCalls.push({ id: detail.id, title: detail.title, date: dateStr, dirName, attendees: attendeeList });

        // Build inbox entry
        const summaryPreview = (detail.summary ?? "").replace(/\n/g, " ").slice(0, 300);
        inboxEntries.push(
          `### ${detail.title} (${dateStr})\nAttendees: ${attendeeList.join(", ") || "—"}\nSummary: ${summaryPreview}\n`
        );
      } catch (e: any) {
        console.error(`Granola: failed to save "${note.title}": ${e.message}`);
      }
    }

    if (savedCalls.length > 0) {
      updateIndex(outputBase, savedCalls);
    }

    // Append to daily inbox
    if (inboxEntries.length > 0) {
      appendToInbox("Meetings", inboxEntries.join("\n"));
    }

    console.log(`Granola: ${savedCalls.length} new calls saved (${notes.length} total)`);
    console.log(`${savedCalls.length} calls extracted`);
  } catch (e: any) {
    console.log(`Granola error: ${e.message}`);
    console.log("0 calls extracted");
  }
  process.exit(0);
}

// --- MCP Server mode ---

const server = new Server(
  { name: "cybos-granola", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_meetings",
      description: "List recent meetings from Granola. Returns meeting IDs, titles, and dates.",
      inputSchema: {
        type: "object" as const,
        properties: {
          days: { type: "number", description: "List meetings from the last N days (default 30)", default: 30 },
        },
      },
    },
    {
      name: "get_meeting",
      description: "Get meeting details including summary and optionally transcript.",
      inputSchema: {
        type: "object" as const,
        properties: {
          note_id: { type: "string", description: "Granola note ID" },
          include_transcript: { type: "boolean", description: "Include full transcript (default true)", default: true },
        },
        required: ["note_id"],
      },
    },
    {
      name: "save_call",
      description: "Save a meeting to vault. Pass data fetched from list_meetings and get_meeting.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Meeting/note ID" },
          title: { type: "string", description: "Meeting title" },
          date: { type: "string", description: "Meeting date (ISO format)" },
          attendees: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                email: { type: "string" },
              },
            },
            description: "List of attendees",
          },
          summary_markdown: {
            type: "string",
            description: "AI-generated summary in markdown",
          },
          transcript_text: {
            type: "string",
            description: "Full transcript text",
          },
        },
        required: ["id", "title", "date"],
      },
    },
    {
      name: "list_saved_calls",
      description: "List meeting IDs already saved in vault. Use to diff against list_meetings for incremental sync.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const apiKey = getApiKey();

  switch (name) {
    case "list_meetings": {
      if (!apiKey) {
        return { content: [{ type: "text", text: "No Granola API key configured. Store it with:\n  security add-generic-password -s cybos.granola -a GRANOLA_API_KEY -w 'grn_...' -U" }] };
      }

      const days = (args as any)?.days ?? 30;
      const createdAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      try {
        const notes = await listNotes(apiKey, createdAfter);
        if (notes.length === 0) {
          return { content: [{ type: "text", text: `No meetings in the last ${days} days.` }] };
        }

        const list = notes.map((n) => {
          const date = formatDate(n.created_at);
          return `- ${date}: **${n.title}** (id: ${n.id})`;
        }).join("\n");

        return { content: [{ type: "text", text: `${notes.length} meeting(s) in the last ${days} days:\n\n${list}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Granola error: ${e.message}` }] };
      }
    }

    case "get_meeting": {
      if (!apiKey) {
        return { content: [{ type: "text", text: "No Granola API key configured." }] };
      }

      const noteId = (args as any)?.note_id;
      if (!noteId) return { content: [{ type: "text", text: "Error: note_id required" }] };

      const includeTranscript = (args as any)?.include_transcript ?? true;

      try {
        const note = await getNote(apiKey, noteId, includeTranscript);

        const parts: string[] = [
          `# ${note.title}`,
          `**Date:** ${formatDate(note.created_at)}`,
          `**ID:** ${note.id}`,
        ];

        if (note.people && note.people.length > 0) {
          const attendeeList = note.people.map((p) => p.name ?? p.email ?? "Unknown").join(", ");
          parts.push(`**Attendees:** ${attendeeList}`);
        }

        if (note.summary) {
          parts.push("", "## Summary", "", note.summary);
        }

        if (note.transcript && note.transcript.length > 0) {
          const transcriptText = note.transcript
            .map((seg) => {
              const speaker = seg.source === "microphone" ? "You" : "Other";
              return `[${speaker}] ${seg.text}`;
            })
            .join("\n");
          parts.push("", "## Transcript", "", transcriptText);
        }

        return { content: [{ type: "text", text: parts.join("\n") }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error fetching meeting: ${e.message}` }] };
      }
    }

    case "save_call": {
      const { id, title, date, attendees, summary_markdown, transcript_text } =
        args as {
          id: string;
          title: string;
          date: string;
          attendees?: Array<{ name?: string; email?: string }>;
          summary_markdown?: string;
          transcript_text?: string;
        };

      const outputBase = resolveVaultPath("private", "context", "calls");
      ensureVaultDir("private", "context", "calls");

      const dateStr = formatDate(date);
      const slug = nameToSlug(title);
      const dirName = `${dateStr}_${slug}`;
      const callDir = join(outputBase, dirName);

      if (existsSync(callDir)) {
        return {
          content: [
            { type: "text", text: `Already saved: ${title} (${dateStr})` },
          ],
        };
      }

      mkdirSync(callDir, { recursive: true });

      const attendeeList = (attendees ?? [])
        .map((a) => a.name ?? a.email)
        .filter((n): n is string => !!n);

      // metadata.json
      writeFileSync(
        join(callDir, "metadata.json"),
        JSON.stringify({ id, title, date, attendees: attendees ?? [] }, null, 2)
      );

      // transcript.txt
      if (transcript_text) {
        writeFileSync(join(callDir, "transcript.txt"), transcript_text);
      }

      // notes.md
      if (summary_markdown) {
        writeFileSync(
          join(callDir, "notes.md"),
          `# Summary\n\n${summary_markdown}`
        );
      }

      const saved: SavedCall = {
        id,
        title,
        date: dateStr,
        dirName,
        attendees: attendeeList,
      };
      updateIndex(outputBase, [saved]);

      return {
        content: [
          { type: "text", text: `Saved: ${title} (${dateStr}) → ${dirName}/` },
        ],
      };
    }

    case "list_saved_calls": {
      const outputBase = resolveVaultPath("private", "context", "calls");
      if (!existsSync(outputBase)) {
        return { content: [{ type: "text", text: "No saved calls yet." }] };
      }

      const dirs = readdirSync(outputBase, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}_/.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a));

      const saved: Array<{ id: string; title: string; date: string }> = [];
      for (const dir of dirs) {
        const metaPath = join(outputBase, dir, "metadata.json");
        if (existsSync(metaPath)) {
          try {
            const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
            saved.push({
              id: meta.id,
              title: meta.title ?? dir,
              date: dir.slice(0, 10),
            });
          } catch {
            // skip malformed
          }
        }
      }

      if (saved.length === 0) {
        return { content: [{ type: "text", text: "No saved calls yet." }] };
      }

      const list = saved
        .map((s) => `- ${s.date}: ${s.title} (id: ${s.id})`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `${saved.length} saved calls:\n${list}`,
          },
        ],
      };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
