/**
 * tg-cleanup — dry-run plan builder (resumable) + plan verification for apply.
 *
 * Enumeration is incremental: each classified+counted chat is appended to
 * enum-cache.jsonl immediately, and state.json tracks enumerating/complete.
 * A dropped dry-run resumes from the cache instead of re-counting everything.
 * The signed plan.json is written only once enumeration completes.
 */

import { TelegramClient } from "telegram";
import {
  ChatPlan,
  Plan,
  EnumState,
  newRunId,
  ensurePlanDir,
  planFile,
  enumCacheFile,
  stateFile,
  findIncompleteRun,
  expiryFrom,
  signPlan,
  appendJsonl,
  readJsonl,
  readJson,
  writeJson,
} from "./shared";
import {
  enumerateChats,
  countOldMessages,
  ChatFilters,
  ClassifiedChat,
} from "./chats";

export interface DryRunOptions {
  olderThan: string;
  cutoffEpoch: number;
  filters: ChatFilters;
  fresh: boolean;
  shouldStop: () => boolean;
}

function toChatPlan(c: ClassifiedChat): Omit<ChatPlan, "count" | "oldest" | "newest" | "sample_ids"> {
  return {
    chat_id: c.chat_id,
    title: c.title,
    type: c.type,
    username: c.username,
    is_admin: c.is_admin,
    mode: c.mode,
    reason: c.reason,
  };
}

export interface DryRunResult {
  runId: string;
  plan: Plan | null; // null if interrupted before completion
  resumed: boolean;
  stopped: boolean;
}

export async function runDryRun(
  client: TelegramClient,
  opts: DryRunOptions
): Promise<DryRunResult> {
  // pick / resume runId
  let runId: string;
  let resumed = false;
  if (!opts.fresh) {
    const incomplete = findIncompleteRun();
    if (incomplete) {
      const st = readJson<EnumState>(stateFile(incomplete));
      if (st && st.older_than === opts.olderThan) {
        runId = incomplete;
        resumed = true;
      } else {
        runId = newRunId();
      }
    } else {
      runId = newRunId();
    }
  } else {
    runId = newRunId();
  }

  ensurePlanDir(runId);
  const nowIso = new Date().toISOString();
  const existingState = readJson<EnumState>(stateFile(runId));
  const state: EnumState = {
    runId,
    status: "enumerating",
    older_than: opts.olderThan,
    cutoff_epoch: opts.cutoffEpoch,
    created_at: existingState?.created_at ?? nowIso,
    updated_at: nowIso,
  };
  writeJson(stateFile(runId), state);

  // already-counted chats from a prior partial run
  const cached = readJsonl<ChatPlan>(enumCacheFile(runId));
  const cachedById = new Map(cached.map((c) => [c.chat_id, c]));

  const classified = await enumerateChats(client, opts.filters);

  for (const c of classified) {
    if (opts.shouldStop()) {
      return { runId, plan: null, resumed, stopped: true };
    }
    if (cachedById.has(c.chat_id)) continue;

    const stats = await countOldMessages(client, c, opts.cutoffEpoch);
    const entry: ChatPlan = { ...toChatPlan(c), ...stats };
    appendJsonl(enumCacheFile(runId), entry);
    cachedById.set(c.chat_id, entry);
    logChatLine(entry);
  }

  // finalize
  const chats = [...cachedById.values()].sort((a, b) =>
    a.chat_id.localeCompare(b.chat_id)
  );
  const created = new Date(state.created_at);
  const plan: Plan = {
    runId,
    created_at: state.created_at,
    expires_at: expiryFrom(created),
    cutoff_epoch: opts.cutoffEpoch,
    older_than: opts.olderThan,
    chats,
    signature: signPlan(runId, opts.cutoffEpoch, chats),
  };
  writeJson(planFile(runId), plan);
  writeJson(stateFile(runId), { ...state, status: "complete", updated_at: new Date().toISOString() });

  return { runId, plan, resumed, stopped: false };
}

function logChatLine(c: ChatPlan): void {
  if (c.mode === "skip") {
    console.log(`  · ${c.title} [${c.type}] — skip (${c.reason})`);
    return;
  }
  const range =
    c.oldest && c.newest
      ? `${c.oldest.slice(0, 10)}..${c.newest.slice(0, 10)}`
      : "—";
  console.log(
    `  · ${c.title} [${c.type}] admin=${c.is_admin} mode=${c.mode} count=${c.count} ${range} sample=[${c.sample_ids.join(",")}]`
  );
}

// --- apply-side verification ---

export class PlanError extends Error {}

/** Load plan.json for a runId and assert it is present, unexpired, and signature-valid. */
export function loadValidPlan(runId: string): Plan {
  const plan = readJson<Plan>(planFile(runId));
  if (!plan) throw new PlanError(`No plan found for runId ${runId}.`);

  const state = readJson<EnumState>(stateFile(runId));
  if (state && state.status !== "complete") {
    throw new PlanError(
      `Plan ${runId} enumeration is incomplete — finish the dry-run first.`
    );
  }
  if (Date.now() > Date.parse(plan.expires_at)) {
    throw new PlanError(
      `Plan ${runId} expired at ${plan.expires_at}. Re-run --dry-run.`
    );
  }
  const expected = signPlan(plan.runId, plan.cutoff_epoch, plan.chats);
  if (expected !== plan.signature) {
    throw new PlanError(`Plan ${runId} signature mismatch — refusing to apply.`);
  }
  return plan;
}
