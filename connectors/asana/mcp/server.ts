#!/usr/bin/env bun
/**
 * Asana MCP server.
 *
 * Auth: Personal Access Token in Keychain (cybos.asana / ASANA_TOKEN).
 *
 * Tools focus on the dealflow review use case:
 *   - find the right project / section / user
 *   - list "next deal to review" tasks (assignee=me, section=X, where 1st Approval is empty)
 *   - read the full deal (name + notes + custom fields + url)
 *   - write a single-select custom field by NAME ("1st Approval" → "Approve") — no GIDs needed
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getSecretUngated } from "../../_shared/keychain-gate";

const API_BASE = "https://app.asana.com/api/1.0";

// --- auth ---

function getApiKey(): string | null {
  return getSecretUngated("asana", "ASANA_TOKEN", "mcp");
}

async function asanaFetch(
  path: string,
  init: { method?: string; body?: any; query?: Record<string, string> } = {},
): Promise<any> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("ASANA_TOKEN not configured in Keychain (cybos.asana)");

  const qs = init.query
    ? "?" + new URLSearchParams(init.query).toString()
    : "";
  const res = await fetch(`${API_BASE}${path}${qs}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Asana ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

// --- typed data shapes (just what we use) ---

interface AsanaUser {
  gid: string;
  name?: string;
  email?: string;
  workspaces?: { gid: string; name: string }[];
}

interface AsanaEnumOption {
  gid: string;
  name: string;
  enabled?: boolean;
}

interface AsanaCustomField {
  gid: string;
  name: string;
  type?: string;
  resource_subtype?: string;
  enum_value?: AsanaEnumOption | null;
  enum_options?: AsanaEnumOption[];
  text_value?: string;
  number_value?: number;
  display_value?: string;
}

interface AsanaMembership {
  project?: { gid: string; name?: string };
  section?: { gid: string; name?: string };
}

interface AsanaTask {
  gid: string;
  name: string;
  notes?: string;
  permalink_url?: string;
  assignee?: { gid: string; name?: string } | null;
  memberships?: AsanaMembership[];
  custom_fields?: AsanaCustomField[];
  completed?: boolean;
  due_on?: string | null;
}

// --- helpers ---

const TASK_OPT_FIELDS = [
  "name",
  "notes",
  "permalink_url",
  "assignee.name",
  "assignee.gid",
  "memberships.project.name",
  "memberships.project.gid",
  "memberships.section.name",
  "memberships.section.gid",
  "custom_fields.gid",
  "custom_fields.name",
  "custom_fields.type",
  "custom_fields.resource_subtype",
  "custom_fields.enum_value.gid",
  "custom_fields.enum_value.name",
  "custom_fields.enum_options.gid",
  "custom_fields.enum_options.name",
  "custom_fields.text_value",
  "custom_fields.number_value",
  "custom_fields.display_value",
  "completed",
  "due_on",
].join(",");

function findField(
  task: AsanaTask,
  fieldName: string,
): AsanaCustomField | undefined {
  const target = fieldName.trim().toLowerCase();
  return task.custom_fields?.find((f) => f.name.trim().toLowerCase() === target);
}

function findEnumOption(
  field: AsanaCustomField,
  optionName: string,
): AsanaEnumOption | undefined {
  const target = optionName.trim().toLowerCase();
  return field.enum_options?.find((o) => o.name.trim().toLowerCase() === target);
}

function formatTask(task: AsanaTask): string {
  const lines: string[] = [];
  lines.push(`## ${task.name}`);
  lines.push("");
  if (task.permalink_url) lines.push(`url: ${task.permalink_url}`);
  if (task.assignee?.name) lines.push(`assignee: ${task.assignee.name}`);
  if (task.due_on) lines.push(`due: ${task.due_on}`);
  if (task.completed) lines.push(`status: completed`);
  if (task.memberships?.length) {
    const sections = task.memberships
      .map((m) => `${m.project?.name ?? "?"}/${m.section?.name ?? "?"}`)
      .join(", ");
    lines.push(`sections: ${sections}`);
  }
  lines.push(`task_gid: ${task.gid}`);
  lines.push("");

  if (task.custom_fields?.length) {
    lines.push("### Custom fields");
    for (const f of task.custom_fields) {
      const val =
        f.display_value ??
        f.enum_value?.name ??
        f.text_value ??
        (f.number_value != null ? String(f.number_value) : "—");
      lines.push(`- **${f.name}**: ${val}`);
    }
    lines.push("");
  }

  if (task.notes?.trim()) {
    lines.push("### Notes");
    lines.push(task.notes.trim());
  }

  return lines.join("\n");
}

// --- API wrappers ---

async function getMe(): Promise<AsanaUser> {
  const r = await asanaFetch("/users/me", {
    query: { opt_fields: "gid,name,email,workspaces.gid,workspaces.name" },
  });
  return r.data;
}

async function listProjects(
  workspaceGid: string,
  nameFilter?: string,
): Promise<{ gid: string; name: string }[]> {
  const r = await asanaFetch("/projects", {
    query: {
      workspace: workspaceGid,
      archived: "false",
      opt_fields: "gid,name",
      limit: "100",
    },
  });
  const all = r.data as { gid: string; name: string }[];
  if (!nameFilter) return all;
  const needle = nameFilter.trim().toLowerCase();
  return all.filter((p) => p.name.toLowerCase().includes(needle));
}

async function listSections(
  projectGid: string,
): Promise<{ gid: string; name: string }[]> {
  const r = await asanaFetch(`/projects/${projectGid}/sections`, {
    query: { opt_fields: "gid,name", limit: "100" },
  });
  return r.data;
}

interface ListTasksOpts {
  project_gid?: string;
  section_gid?: string;
  assignee_gid?: string; // filters in this section only (Asana search needs workspace)
  workspace_gid?: string;
  empty_custom_field?: string; // field name; tasks where this field has no value pass
  limit?: number;
}

async function listTasks(opts: ListTasksOpts): Promise<AsanaTask[]> {
  // Sections expose `tasks` directly. We paginate fully so client-side
  // filters (assignee, empty_custom_field) see every task in the section,
  // not just the first page.
  if (!opts.section_gid) {
    throw new Error("section_gid required");
  }
  let tasks: AsanaTask[] = [];
  let offset: string | undefined = undefined;
  const pageLimit = 100;
  // Safety cap: Top_Funnel-class sections rarely exceed a few thousand.
  for (let i = 0; i < 50; i++) {
    const query: Record<string, string> = {
      opt_fields: TASK_OPT_FIELDS,
      limit: String(pageLimit),
    };
    if (offset) query.offset = offset;
    const r: { data: AsanaTask[]; next_page?: { offset?: string } | null } =
      await asanaFetch(`/sections/${opts.section_gid}/tasks`, { query });
    tasks.push(...r.data);
    if (!r.next_page?.offset) break;
    offset = r.next_page.offset;
  }

  if (opts.assignee_gid) {
    tasks = tasks.filter((t) => t.assignee?.gid === opts.assignee_gid);
  }
  if (opts.empty_custom_field) {
    const needle = opts.empty_custom_field.trim().toLowerCase();
    tasks = tasks.filter((t) => {
      const f = t.custom_fields?.find(
        (c) => c.name.trim().toLowerCase() === needle,
      );
      if (!f) return false;
      const hasValue =
        (f.enum_value && f.enum_value.gid) ||
        (f.text_value && f.text_value.trim()) ||
        f.number_value != null;
      return !hasValue;
    });
  }

  // Exclude completed tasks — reviewer cares about the live funnel.
  tasks = tasks.filter((t) => !t.completed);

  if (opts.limit && tasks.length > opts.limit) {
    tasks = tasks.slice(0, opts.limit);
  }

  return tasks;
}

async function getTask(taskGid: string): Promise<AsanaTask> {
  const r = await asanaFetch(`/tasks/${taskGid}`, {
    query: { opt_fields: TASK_OPT_FIELDS },
  });
  return r.data;
}

async function addComment(
  taskGid: string,
  text: string,
): Promise<{ ok: true; story_gid: string }> {
  const r = await asanaFetch(`/tasks/${taskGid}/stories`, {
    method: "POST",
    body: { data: { text } },
  });
  return { ok: true, story_gid: r.data?.gid };
}

async function setField(
  taskGid: string,
  fieldName: string,
  value: string,
): Promise<{ ok: true; before: string | null; after: string }> {
  const task = await getTask(taskGid);
  const field = findField(task, fieldName);
  if (!field) {
    throw new Error(
      `field "${fieldName}" not found on this task. available: ${task.custom_fields?.map((c) => c.name).join(", ")}`,
    );
  }

  const beforeRaw =
    field.display_value ??
    field.enum_value?.name ??
    field.text_value ??
    (field.number_value != null ? String(field.number_value) : null);

  let cfValue: any;
  const subtype = field.resource_subtype ?? field.type;

  if (subtype === "enum") {
    const opt = findEnumOption(field, value);
    if (!opt) {
      throw new Error(
        `enum option "${value}" not found. available: ${field.enum_options?.map((o) => o.name).join(", ")}`,
      );
    }
    cfValue = opt.gid;
  } else if (subtype === "text") {
    cfValue = value;
  } else if (subtype === "number") {
    const n = Number(value);
    if (isNaN(n)) throw new Error(`"${value}" is not a number`);
    cfValue = n;
  } else {
    // Default to text-style write.
    cfValue = value;
  }

  await asanaFetch(`/tasks/${taskGid}`, {
    method: "PUT",
    body: { data: { custom_fields: { [field.gid]: cfValue } } },
  });

  return { ok: true, before: beforeRaw, after: value };
}

// --- MCP server ---

const server = new Server(
  { name: "cybos-asana", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "me",
      description:
        "Get the authenticated Asana user. Returns gid, name, email, and the list of workspaces.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "list_workspaces",
      description: "List workspaces the user can access.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "list_projects",
      description:
        "List projects in a workspace. Optionally filter by name (substring, case-insensitive).",
      inputSchema: {
        type: "object" as const,
        properties: {
          workspace_gid: { type: "string", description: "Workspace GID" },
          name_filter: {
            type: "string",
            description: "Substring of project name to match",
          },
        },
        required: ["workspace_gid"],
      },
    },
    {
      name: "list_sections",
      description: "List sections (board columns or list groupings) in a project.",
      inputSchema: {
        type: "object" as const,
        properties: {
          project_gid: { type: "string" },
        },
        required: ["project_gid"],
      },
    },
    {
      name: "list_tasks",
      description:
        "List active tasks in a section. Supports filtering by assignee_gid and `empty_custom_field` (returns only tasks where that custom field has no value).",
      inputSchema: {
        type: "object" as const,
        properties: {
          section_gid: { type: "string" },
          assignee_gid: {
            type: "string",
            description: "If set, returns only tasks assigned to this user GID",
          },
          empty_custom_field: {
            type: "string",
            description:
              'If set, returns only tasks where the named custom field has no value (e.g. "1st Approval")',
          },
          limit: { type: "number", default: 100 },
        },
        required: ["section_gid"],
      },
    },
    {
      name: "get_task",
      description:
        "Get full task details (name, notes, custom fields with current values + available enum options, assignee, sections, permalink).",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_gid: { type: "string" },
        },
        required: ["task_gid"],
      },
    },
    {
      name: "set_field",
      description:
        'Set a single custom field on a task by field name and value. For single-select fields, pass the option name (e.g. "Approve"). For text fields, pass the string. Returns before/after.',
      inputSchema: {
        type: "object" as const,
        properties: {
          task_gid: { type: "string" },
          field_name: { type: "string", description: 'e.g. "1st Approval"' },
          value: { type: "string", description: 'e.g. "Approve" or "Reject"' },
        },
        required: ["task_gid", "field_name", "value"],
      },
    },
    {
      name: "add_comment",
      description:
        "Add a comment (story) to a task. Use this to record human reasoning, context, or follow-up notes on the task itself so it travels with the deal in Asana.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_gid: { type: "string" },
          text: { type: "string", description: "Comment body (plain text)." },
        },
        required: ["task_gid", "text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, any>;

  try {
    switch (name) {
      case "me": {
        const user = await getMe();
        return {
          content: [
            { type: "text", text: JSON.stringify(user, null, 2) },
          ],
        };
      }

      case "list_workspaces": {
        const r = await asanaFetch("/workspaces", {
          query: { opt_fields: "gid,name" },
        });
        return {
          content: [
            { type: "text", text: JSON.stringify(r.data, null, 2) },
          ],
        };
      }

      case "list_projects": {
        const list = await listProjects(a.workspace_gid, a.name_filter);
        return {
          content: [
            { type: "text", text: JSON.stringify(list, null, 2) },
          ],
        };
      }

      case "list_sections": {
        const list = await listSections(a.project_gid);
        return {
          content: [
            { type: "text", text: JSON.stringify(list, null, 2) },
          ],
        };
      }

      case "list_tasks": {
        const tasks = await listTasks({
          section_gid: a.section_gid,
          assignee_gid: a.assignee_gid,
          empty_custom_field: a.empty_custom_field,
          limit: a.limit ?? 100,
        });
        // Compact output: gid + name + url + key custom fields summary.
        const summaries = tasks.map((t) => ({
          gid: t.gid,
          name: t.name,
          url: t.permalink_url,
          assignee: t.assignee?.name ?? null,
          custom_fields: (t.custom_fields ?? []).map((f) => ({
            name: f.name,
            value:
              f.display_value ??
              f.enum_value?.name ??
              f.text_value ??
              (f.number_value != null ? String(f.number_value) : null),
          })),
        }));
        return {
          content: [
            {
              type: "text",
              text: `${summaries.length} task(s)\n\n${JSON.stringify(summaries, null, 2)}`,
            },
          ],
        };
      }

      case "get_task": {
        const task = await getTask(a.task_gid);
        return { content: [{ type: "text", text: formatTask(task) }] };
      }

      case "set_field": {
        const result = await setField(a.task_gid, a.field_name, a.value);
        return {
          content: [
            {
              type: "text",
              text: `set ${a.field_name}: ${result.before ?? "—"} → ${result.after}`,
            },
          ],
        };
      }

      case "add_comment": {
        const result = await addComment(a.task_gid, a.text);
        return {
          content: [
            { type: "text", text: `comment added (story_gid: ${result.story_gid})` },
          ],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `Error: ${e.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
