#!/usr/bin/env bun
/**
 * tg-cleanup — bulk-delete old Telegram messages, with a local archive of
 * everything deleted and full interrupt/resume safety.
 *
 *   bun scripts/tg-cleanup/index.ts --dry-run --older-than 30d
 *   bun scripts/tg-cleanup/index.ts --dry-run --older-than 30d --folder "Work" --exclude-chat @someuser
 *   bun scripts/tg-cleanup/index.ts --dry-run --fresh        # force a new runId
 *   bun scripts/tg-cleanup/index.ts --apply --plan <runId>   # also the resume command
 *
 * See vault/private/projects/tg-cleanup/deliverables/requirements.md.
 */

import { createClient, connectAuthenticated } from "../../connectors/telegram/core/client";
import { listFolderChats } from "../../connectors/telegram/core/dialogs";
import { parseOlderThan, PLAN_EXPIRY_HOURS } from "./shared";
import { runDryRun } from "./plan";
import { loadValidPlan, PlanError } from "./plan";
import { runApply } from "./execute";
import { requireTouchId } from "./biometrics";

interface Args {
  dryRun: boolean;
  apply: boolean;
  olderThan: string;
  plan: string | null;
  folder: string | null;
  include: string[];
  exclude: string[];
  fresh: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dryRun: false,
    apply: false,
    olderThan: "30d",
    plan: null,
    folder: null,
    include: [],
    exclude: [],
    fresh: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--dry-run": a.dryRun = true; break;
      case "--apply": a.apply = true; break;
      case "--older-than": a.olderThan = next(); break;
      case "--plan": a.plan = next(); break;
      case "--folder": a.folder = next(); break;
      case "--include-chat": a.include.push(next()); break;
      case "--exclude-chat": a.exclude.push(next()); break;
      case "--fresh": a.fresh = true; break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return a;
}

function usage(): void {
  console.log(
    [
      "tg-cleanup",
      "",
      "  --dry-run --older-than 30d [--folder NAME] [--include-chat @h] [--exclude-chat @h] [--fresh]",
      "  --apply --plan <runId>",
      "",
      "Modes are mutually exclusive. --apply requires Touch ID.",
    ].join("\n")
  );
}

async function main(): Promise<void> {
  // GramJS computes `waitTime - now` on its first paged fetch, yielding a
  // harmless negative setTimeout. Swallow that one warning; surface the rest.
  process.on("warning", (w) => {
    if (w.name === "TimeoutNegativeWarning") return;
    console.warn(w);
  });

  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun === args.apply) {
    usage();
    throw new Error("Specify exactly one of --dry-run or --apply.");
  }

  // graceful-stop wiring
  let stopRequested = false;
  const shouldStop = () => stopRequested;
  const onSignal = (sig: string) => {
    if (stopRequested) return;
    stopRequested = true;
    console.log(`\n${sig} received — finishing the in-flight batch, then stopping…`);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  if (args.apply) {
    if (!args.plan) throw new Error("--apply requires --plan <runId>.");
    const plan = loadValidPlan(args.plan); // verifies presence, expiry, signature
    requireTouchId(`tg-cleanup: delete old Telegram messages (plan ${plan.runId})`);

    const client = await createClient({ caller: "collect", silent: true });
    await connectAuthenticated(client);
    try {
      const r = await runApply(client, plan, shouldStop);
      console.log(
        `\n${r.partial ? "STOPPED (partial)" : "DONE"} — chats ${r.chatsTouched}, deleted ${r.deleted}, retries ${r.retries}, flood ${r.floodSeconds}s, ${(r.wallclockMs / 1000).toFixed(1)}s`
      );
      if (r.partial) {
        console.log(`Resume with: bun scripts/tg-cleanup/index.ts --apply --plan ${plan.runId}`);
      }
    } finally {
      await client.disconnect();
    }
    process.exit(0);
  }

  // dry-run
  const cutoffEpoch = parseOlderThan(args.olderThan);
  const client = await createClient({ caller: "collect", silent: true });
  await connectAuthenticated(client);
  try {
    const allowedChatIds = args.folder
      ? await resolveFolder(client, args.folder)
      : undefined;

    const res = await runDryRun(client, {
      olderThan: args.olderThan,
      cutoffEpoch,
      filters: { allowedChatIds, include: args.include, exclude: args.exclude },
      fresh: args.fresh,
      shouldStop,
    });

    if (res.stopped) {
      console.log(`\nStopped mid-enumeration. Resume with: bun scripts/tg-cleanup/index.ts --dry-run --older-than ${args.olderThan}`);
      process.exit(0);
    }

    const plan = res.plan!;
    const toDelete = plan.chats.filter((c) => c.mode !== "skip");
    const totalMsgs = toDelete.reduce((a, c) => a + c.count, 0);
    console.log(
      `\nPlan ${plan.runId}${res.resumed ? " (resumed)" : ""}: ${toDelete.length} chats, ~${totalMsgs} messages older than ${args.olderThan}.`
    );
    console.log(`Expires in ${PLAN_EXPIRY_HOURS}h (${plan.expires_at}).`);
    console.log(`\nNext: bun scripts/tg-cleanup/index.ts --apply --plan ${plan.runId}`);
  } finally {
    await client.disconnect();
  }
  process.exit(0);
}

async function resolveFolder(
  client: Awaited<ReturnType<typeof createClient>>,
  folder: string
): Promise<Set<string>> {
  const res = await listFolderChats(client, folder);
  if (!res) throw new Error(`Folder "${folder}" not found.`);
  console.log(`Folder "${res.folder}": ${res.chats.length} chats.`);
  return new Set(res.chats.map((c) => c.id));
}

main().catch((err) => {
  if (err instanceof PlanError) console.error(`Plan error: ${err.message}`);
  else console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
