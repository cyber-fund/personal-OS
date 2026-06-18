/**
 * tg-cleanup — executor for --apply.
 *
 * Per-batch ordering invariant (any crash point is safe & idempotent):
 *   1. fetch full message objects
 *   2. append them to archive/<chat_id>.jsonl
 *   3. deleteMessages
 *   4. append the audit line
 *
 * Resume: on start, audit.jsonl yields the already-deleted ids per chat; those
 * are skipped. Graceful stop (SIGINT/SIGTERM) is checked between batches only,
 * so the in-flight batch always completes the ordering above.
 */

import { TelegramClient, Api, errors } from "telegram";
import { Plan } from "./shared";
import { auditFile, appendJsonl, readJsonl, sleep, buildArchiveNames } from "./shared";
import { ChatArchive, toArchived } from "./archive";

const BATCH_SIZE = 100;
const BASE_BATCH_SLEEP_MS = 500;
const MAX_BATCH_SLEEP_MS = 8000;
const FLOOD_WINDOW_MS = 60_000;
const FLOOD_THRESHOLD_S = 30; // flood-seconds/min above this -> slow down
const CHAT_CONCURRENCY = 3;

interface AuditBatch {
  ts: string;
  chat_id: string;
  chat_title: string;
  type: string;
  ids: number[];
  count: number;
  retries: number;
  duration_ms: number;
}

/** Global adaptive pacer shared across concurrent chats. */
class Pacer {
  private events: { t: number; s: number }[] = [];
  current = BASE_BATCH_SLEEP_MS;
  totalFloodS = 0;

  recordFlood(seconds: number): void {
    const now = Date.now();
    this.events.push({ t: now, s: seconds });
    this.totalFloodS += seconds;
    this.recompute();
  }
  private recompute(): void {
    const cutoff = Date.now() - FLOOD_WINDOW_MS;
    this.events = this.events.filter((e) => e.t >= cutoff);
    const recent = this.events.reduce((a, e) => a + e.s, 0);
    if (recent > FLOOD_THRESHOLD_S) {
      this.current = Math.min(MAX_BATCH_SLEEP_MS, this.current * 2);
    } else if (this.current > BASE_BATCH_SLEEP_MS) {
      this.current = Math.max(BASE_BATCH_SLEEP_MS, Math.floor(this.current / 2));
    }
  }
  get sleepMs(): number {
    return this.current;
  }
}

export interface ApplyResult {
  chatsTouched: number;
  deleted: number;
  retries: number;
  floodSeconds: number;
  partial: boolean;
  wallclockMs: number;
}

function buildDeletedSets(runId: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const line of readJsonl<AuditBatch>(auditFile(runId))) {
    if (!line.ids) continue;
    if (!map.has(line.chat_id)) map.set(line.chat_id, new Set());
    const set = map.get(line.chat_id)!;
    for (const id of line.ids) set.add(id);
  }
  return map;
}

async function resolveEntities(
  client: TelegramClient,
  plan: Plan
): Promise<Map<string, Api.TypeInputPeer>> {
  const dialogs = await client.getDialogs({ limit: 1000 });
  const byId = new Map<string, Api.TypeInputPeer>();
  for (const d of dialogs) {
    if (d.id) byId.set(d.id.toString(), d.inputEntity as Api.TypeInputPeer);
  }
  // fallback for chats not in the dialog list (e.g. via --include-chat handle)
  for (const c of plan.chats) {
    if (c.mode === "skip" || byId.has(c.chat_id)) continue;
    const ref = c.username ?? c.chat_id;
    try {
      byId.set(c.chat_id, await client.getInputEntity(ref));
    } catch {
      console.warn(`  ! could not resolve entity for ${c.title} (${c.chat_id}) — skipping`);
    }
  }
  return byId;
}

async function deleteWithFloodRetry(
  client: TelegramClient,
  entity: Api.TypeInputPeer,
  ids: number[],
  pacer: Pacer
): Promise<number> {
  let retries = 0;
  for (;;) {
    try {
      await client.deleteMessages(entity, ids, { revoke: true });
      return retries;
    } catch (err) {
      if (err instanceof errors.FloodWaitError) {
        retries++;
        const wait = err.seconds + 1;
        pacer.recordFlood(err.seconds);
        console.log(`    FLOOD_WAIT ${err.seconds}s — sleeping ${wait}s, retrying`);
        await sleep(wait * 1000);
        continue;
      }
      throw err;
    }
  }
}

async function processChat(
  client: TelegramClient,
  plan: Plan,
  chat: Plan["chats"][number],
  entity: Api.TypeInputPeer,
  fileBase: string,
  alreadyDeleted: Set<number>,
  pacer: Pacer,
  shouldStop: () => boolean,
  totals: { deleted: number; retries: number }
): Promise<boolean> {
  const archive = new ChatArchive(plan.runId, fileBase);
  const params: any = { offsetDate: plan.cutoff_epoch };
  if (chat.mode === "mine") params.fromUser = "me";

  console.log(`> ${chat.title} [${chat.type}] mode=${chat.mode} — start`);

  let batch: any[] = [];
  let chatDeleted = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const msgs = batch;
    batch = [];
    const ids = msgs.map((m) => m.id);
    const t0 = Date.now();

    archive.write(msgs.map((m) => toArchived(m, chat))); // step 2 (before delete)
    const retries = await deleteWithFloodRetry(client, entity, ids, pacer); // step 3

    const auditLine: AuditBatch = {
      ts: new Date().toISOString(),
      chat_id: chat.chat_id,
      chat_title: chat.title,
      type: chat.type,
      ids,
      count: ids.length,
      retries,
      duration_ms: Date.now() - t0,
    };
    appendJsonl(auditFile(plan.runId), auditLine); // step 4

    chatDeleted += ids.length;
    totals.deleted += ids.length;
    totals.retries += retries;
    console.log(`    batch -${ids.length}${retries ? ` (retries ${retries})` : ""} [chat total ${chatDeleted}]`);
    await sleep(pacer.sleepMs);
  };

  for await (const msg of client.iterMessages(entity, params)) {
    if (!msg || (msg as any).pinned) continue;
    if (alreadyDeleted.has(msg.id)) continue;
    batch.push(msg);
    if (batch.length >= BATCH_SIZE) {
      await flush();
      if (shouldStop()) {
        console.log(`< ${chat.title} — stopped (will resume on re-run)`);
        return false;
      }
    }
  }
  await flush();
  console.log(`< ${chat.title} — done (${chatDeleted} deleted)`);
  return true;
}

export async function runApply(
  client: TelegramClient,
  plan: Plan,
  shouldStop: () => boolean
): Promise<ApplyResult> {
  const t0 = Date.now();
  const pacer = new Pacer();
  const deletedSets = buildDeletedSets(plan.runId);
  const entities = await resolveEntities(client, plan);
  const archiveNames = buildArchiveNames(plan.chats);
  const totals = { deleted: 0, retries: 0 };

  const queue = plan.chats.filter(
    (c) => c.mode !== "skip" && entities.has(c.chat_id)
  );
  const touched = new Set<string>();
  let partial = false;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      if (shouldStop()) {
        partial = true;
        return;
      }
      const chat = queue[cursor++];
      touched.add(chat.chat_id);
      const completed = await processChat(
        client,
        plan,
        chat,
        entities.get(chat.chat_id)!,
        archiveNames.get(chat.chat_id)!,
        deletedSets.get(chat.chat_id) ?? new Set(),
        pacer,
        shouldStop,
        totals
      ).catch((err) => {
        console.warn(`  ! ${chat.title} failed: ${(err as Error).message}`);
        return true; // don't wedge the queue on one chat
      });
      if (!completed) partial = true;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CHAT_CONCURRENCY, queue.length) }, worker)
  );

  const result: ApplyResult = {
    chatsTouched: touched.size,
    deleted: totals.deleted,
    retries: totals.retries,
    floodSeconds: pacer.totalFloodS,
    partial: partial || shouldStop(),
    wallclockMs: Date.now() - t0,
  };

  appendJsonl(auditFile(plan.runId), {
    ts: new Date().toISOString(),
    summary: true,
    partial: result.partial,
    chats_touched: result.chatsTouched,
    deleted: result.deleted,
    retries: result.retries,
    flood_seconds: result.floodSeconds,
    wallclock_ms: result.wallclockMs,
  });

  return result;
}
