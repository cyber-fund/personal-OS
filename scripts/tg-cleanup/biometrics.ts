/**
 * Touch ID gate for --apply. Reuses the prebuilt Swift helper at
 * connectors/_shared/touch-id/touch-id-helper (exit 0 = biometric success).
 *
 * This is a hard, Claude-proof wall: a non-interactive bash session cannot
 * satisfy the biometric prompt, so it can never run --apply on its own.
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const HELPER = join(
  import.meta.dir,
  "..",
  "..",
  "connectors",
  "_shared",
  "touch-id",
  "touch-id-helper"
);

export function requireTouchId(reason: string): void {
  if (!existsSync(HELPER)) {
    throw new Error(
      `Touch ID helper not found at ${HELPER}. Build it: bun run build:touch-id`
    );
  }
  const res = spawnSync(HELPER, [reason], { stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error("Touch ID not approved — aborting --apply.");
  }
}
