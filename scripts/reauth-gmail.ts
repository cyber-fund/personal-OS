#!/usr/bin/env bun
/**
 * Re-authorize the Google (Gmail/Workspace) connector WITHOUT the setup wizard.
 *
 * Mints a fresh OAuth refresh token carrying the full WORKSPACE_SCOPES set
 * (Gmail + Calendar events + Docs/Sheets/Slides read-only) and stores it in the
 * Keychain (cybos.gmail / GMAIL_REFRESH_TOKEN), overwriting the old,
 * narrowly-scoped token.
 *
 * Reuses the same redirect URI the OAuth client already has registered
 * (http://localhost:3847/api/gmail/callback), so no Google Cloud Console change
 * is needed. Client id/secret are read from the Keychain (store them first with
 * scripts/store-gmail-creds.ts if missing).
 *
 * Usage:  bun scripts/reauth-gmail.ts
 */

import { spawnSync } from "child_process";
import { getSecretUngated, storeSecret } from "../connectors/_shared/keychain-gate";
import { WORKSPACE_SCOPES } from "../connectors/gmail/mcp/google";

const PORT = 3847;
const REDIRECT_URI = `http://localhost:${PORT}/api/gmail/callback`;
const CALLBACK_PATH = "/api/gmail/callback";

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

const clientId = getSecretUngated("gmail", "GMAIL_CLIENT_ID", "collect");
const clientSecret = getSecretUngated("gmail", "GMAIL_CLIENT_SECRET", "collect");
if (!clientId || !clientSecret) {
  fail(
    "GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not in Keychain.\n" +
      "  Store them first: bun scripts/store-gmail-creds.ts <CLIENT_ID> <CLIENT_SECRET>"
  );
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: WORKSPACE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // force re-consent so Google returns a NEW refresh token
  }).toString();

const htmlPage = (color: string, title: string, body: string) =>
  `<html><body style="background:#0a0a0a;color:${color};font-family:system-ui;padding:40px;text-align:center">` +
  `<h2>${title}</h2><p>${body}</p></body></html>`;

async function exchangeCode(code: string): Promise<{ refresh_token?: string; scope?: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId!,
      client_secret: clientSecret!,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

const result = await new Promise<{ ok: boolean; scope?: string }>((resolve) => {
  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== CALLBACK_PATH) return new Response("Not found", { status: 404 });

      const error = url.searchParams.get("error");
      if (error) {
        resolve({ ok: false });
        queueMicrotask(() => server.stop());
        return new Response(htmlPage("#f87171", "Authorization Failed", error), {
          headers: { "Content-Type": "text/html" },
        });
      }

      const code = url.searchParams.get("code");
      if (!code) {
        return new Response(htmlPage("#f87171", "No code received", "Close this tab and retry."), {
          headers: { "Content-Type": "text/html" },
        });
      }

      try {
        const tokens = await exchangeCode(code);
        if (!tokens.refresh_token) {
          resolve({ ok: false });
          queueMicrotask(() => server.stop());
          return new Response(
            htmlPage(
              "#f87171",
              "No refresh token returned",
              'Revoke access at <a style="color:#4a9eff" href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and run this again.'
            ),
            { headers: { "Content-Type": "text/html" } }
          );
        }
        storeSecret("gmail", "GMAIL_REFRESH_TOKEN", tokens.refresh_token);
        resolve({ ok: true, scope: tokens.scope });
        queueMicrotask(() => server.stop());
        return new Response(
          htmlPage("#4ade80", "Gmail Re-authorized", "Refresh token saved. You can close this tab."),
          { headers: { "Content-Type": "text/html" } }
        );
      } catch (e: any) {
        resolve({ ok: false });
        queueMicrotask(() => server.stop());
        return new Response(htmlPage("#f87171", "Token Exchange Error", e.message ?? String(e)), {
          headers: { "Content-Type": "text/html" },
        });
      }
    },
  });

  console.log(`\nListening on ${REDIRECT_URI}`);
  console.log("Opening the Google consent screen — approve EVERY requested scope.\n");
  console.log(`If the browser doesn't open, paste this URL:\n${authUrl}\n`);
  spawnSync("open", [authUrl]);
});

if (!result.ok) fail("Re-authorization did not complete. See the message in the browser tab.");

const granted = (result.scope ?? "").split(/\s+/).filter(Boolean);
const missing = WORKSPACE_SCOPES.filter((s) => !granted.includes(s));

console.log("✓ New refresh token stored in Keychain (cybos.gmail / GMAIL_REFRESH_TOKEN)");
console.log("\nGranted scopes:");
for (const s of granted) console.log(`  - ${s}`);

if (missing.length) {
  console.log("\n⚠ Still missing the following scopes (re-run and approve all on the consent screen):");
  for (const s of missing) console.log(`  - ${s}`);
  process.exit(1);
}
console.log("\nAll WORKSPACE_SCOPES granted. Re-run the tests to verify the live connection.");
process.exit(0);
