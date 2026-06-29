#!/usr/bin/env bun
/**
 * personal-OS — Web UI Server
 *
 * Hono server on localhost:3847
 * Serves setup wizard and management UI
 */

import { Hono } from "hono";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, symlinkSync, lstatSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { computeCheck } from "telegram/Password";
import { WORKSPACE_SCOPES } from "../../connectors/gmail/mcp/google";
import {
  getConfig,
  saveConfig,
  isSetupComplete,
  getConfigDir,
  type CybosConfig,
} from "../../connectors/_shared/vault";
import { storeSecret } from "../../connectors/_shared/keychain-gate";

const app = new Hono();
const PORT = 3847;
const CONFIG_DIR = getConfigDir();
const PROJECT_ROOT = join(import.meta.dir, "../..");

// --- API Routes ---

// Get setup status
app.get("/api/status", (c) => {
  return c.json({
    setup_complete: isSetupComplete(),
    config: getConfig(),
  });
});

// Open native macOS folder picker
app.get("/api/pick-folder", (c) => {
  const result = spawnSync("osascript", [
    "-e",
    'set chosenFolder to POSIX path of (choose folder with prompt "Choose vault location")',
  ], { stdio: "pipe", timeout: 60000 });

  if (result.status !== 0) {
    return c.json({ success: false, error: "Cancelled" });
  }

  const folder = result.stdout.toString().trim().replace(/\/$/, "");
  return c.json({ success: true, path: folder });
});

// Save vault path
app.post("/api/vault", async (c) => {
  const { vault_path } = await c.req.json();
  const vaultPath = (vault_path || "~/personal-OS-vault").replace("~", homedir());

  const config: CybosConfig = {
    version: "1.0.0",
    vault: { path: vaultPath, created: new Date().toISOString().slice(0, 10) },
    setup_complete: false,
  };

  saveConfig(config);
  return c.json({ success: true });
});

// Store a secret in Keychain
app.post("/api/secrets", async (c) => {
  const { connector, key, value } = await c.req.json();
  try {
    storeSecret(connector, key, value);
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// --- Telegram in-wizard auth flow ---
// State held in server memory for the duration of the auth flow.
let tgAuth: {
  client: TelegramClient;
  phone: string;
  phoneCodeHash: string;
} | null = null;

async function cleanupTgAuth() {
  if (tgAuth) {
    try { await tgAuth.client.disconnect(); } catch {}
    tgAuth = null;
  }
}

// Send a login code to the user's phone
app.post("/api/telegram/send-code", async (c) => {
  try {
    const { phone, api_id, api_hash } = await c.req.json();
    if (!phone || !api_id || !api_hash) {
      return c.json({ success: false, error: "Missing phone or API credentials" }, 400);
    }

    await cleanupTgAuth();

    const apiId = parseInt(api_id, 10);
    const client = new TelegramClient(new StringSession(""), apiId, api_hash, {
      connectionRetries: 3,
    });
    await client.connect();

    const result: any = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId,
        apiHash: api_hash,
        settings: new Api.CodeSettings({}),
      })
    );

    tgAuth = { client, phone, phoneCodeHash: result.phoneCodeHash };
    return c.json({ success: true });
  } catch (e: any) {
    await cleanupTgAuth();
    return c.json({ success: false, error: e.message }, 400);
  }
});

// Verify the SMS / Telegram code
app.post("/api/telegram/verify-code", async (c) => {
  if (!tgAuth) return c.json({ success: false, error: "No active auth session. Click 'Send Code' first." }, 400);
  try {
    const { code } = await c.req.json();
    await tgAuth.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: tgAuth.phone,
        phoneCodeHash: tgAuth.phoneCodeHash,
        phoneCode: code,
      })
    );
    // Auth succeeded — save session to Keychain
    const sessionString = tgAuth.client.session.save() as unknown as string;
    storeSecret("telegram", "TELEGRAM_SESSION", sessionString);
    await cleanupTgAuth();
    return c.json({ success: true });
  } catch (e: any) {
    if (e.errorMessage === "SESSION_PASSWORD_NEEDED" || /SESSION_PASSWORD_NEEDED/.test(e.message)) {
      return c.json({ success: false, needsPassword: true });
    }
    return c.json({ success: false, error: e.message }, 400);
  }
});

// Verify 2FA password (only when needsPassword: true)
app.post("/api/telegram/verify-password", async (c) => {
  if (!tgAuth) return c.json({ success: false, error: "No active auth session" }, 400);
  try {
    const { password } = await c.req.json();
    const passwordSrp: any = await tgAuth.client.invoke(new Api.account.GetPassword());
    const passwordSrpCheck = await computeCheck(passwordSrp, password);
    await tgAuth.client.invoke(new Api.auth.CheckPassword({ password: passwordSrpCheck }));

    const sessionString = tgAuth.client.session.save() as unknown as string;
    storeSecret("telegram", "TELEGRAM_SESSION", sessionString);
    await cleanupTgAuth();
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// --- Gmail OAuth flow ---

app.get("/api/gmail/auth-url", (c) => {
  const clientId = c.req.query("client_id");
  if (!clientId) return c.json({ error: "client_id required" }, 400);

  const redirectUri = `http://localhost:${PORT}/api/gmail/callback`;
  const scopes = WORKSPACE_SCOPES.join(" ");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes,
    access_type: "offline",
    prompt: "consent",
  });

  return c.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

app.get("/api/gmail/callback", async (c) => {
  try {
    const code = c.req.query("code");
    const error = c.req.query("error");

    if (error) {
      return c.html(`<html><body style="background:#0a0a0a;color:#f87171;font-family:system-ui;padding:40px"><h2>Gmail Authorization Failed</h2><p>${error}</p><p>Close this tab and try again.</p></body></html>`);
    }

    if (!code) {
      return c.html(`<html><body style="background:#0a0a0a;color:#f87171;font-family:system-ui;padding:40px"><h2>No authorization code received</h2><p>Close this tab and try again.</p></body></html>`);
    }

    // Exchange code for tokens — client_id and client_secret should already be in Keychain
    const clientId = spawnSync("security", ["find-generic-password", "-s", "cybos.gmail", "-a", "GMAIL_CLIENT_ID", "-w"], { stdio: "pipe" });
    const clientSecret = spawnSync("security", ["find-generic-password", "-s", "cybos.gmail", "-a", "GMAIL_CLIENT_SECRET", "-w"], { stdio: "pipe" });

    if (clientId.status !== 0 || clientSecret.status !== 0) {
      return c.html(`<html><body style="background:#0a0a0a;color:#f87171;font-family:system-ui;padding:40px"><h2>Gmail credentials not found</h2><p>Store client ID and secret first, then try again.</p></body></html>`);
    }

    const redirectUri = `http://localhost:${PORT}/api/gmail/callback`;
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId.stdout.toString().trim(),
        client_secret: clientSecret.stdout.toString().trim(),
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text().catch(() => "");
      return c.html(`<html><body style="background:#0a0a0a;color:#f87171;font-family:system-ui;padding:40px"><h2>Token Exchange Failed</h2><pre>${err}</pre></body></html>`);
    }

    const tokens = await tokenRes.json() as { refresh_token?: string; access_token: string };
    if (!tokens.refresh_token) {
      return c.html(`<html><body style="background:#0a0a0a;color:#f87171;font-family:system-ui;padding:40px"><h2>No refresh token received</h2><p>Try revoking access at <a href="https://myaccount.google.com/permissions" style="color:#4a9eff">myaccount.google.com/permissions</a> and re-authorizing.</p></body></html>`);
    }

    storeSecret("gmail", "GMAIL_REFRESH_TOKEN", tokens.refresh_token);

    return c.html(`<html><body style="background:#0a0a0a;color:#4ade80;font-family:system-ui;padding:40px;text-align:center"><h2>Gmail Connected</h2><p>Refresh token saved to Keychain. You can close this tab and return to the setup wizard.</p><script>window.opener && window.opener.postMessage({type:'gmail-auth-done'}, '*')</script></body></html>`);
  } catch (e: any) {
    console.error("Gmail callback error:", e);
    return c.html(`<html><body style="background:#0a0a0a;color:#f87171;font-family:system-ui;padding:40px"><h2>Gmail Authorization Error</h2><pre>${e.message || e}</pre><p>Check the server console for details.</p></body></html>`);
  }
});

// Save connectors config + Twitter accounts
app.post("/api/connectors", async (c) => {
  const body = await c.req.json();
  const connectorsPath = join(CONFIG_DIR, "connectors.json");
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(connectorsPath, JSON.stringify(body, null, 2));

  // Initialize empty twitter-accounts.json if missing (accounts are auto-discovered on sync)
  const twAccountsPath = join(CONFIG_DIR, "twitter-accounts.json");
  if (!existsSync(twAccountsPath)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(twAccountsPath, JSON.stringify({ accounts: [] }, null, 2));
  }

  return c.json({ success: true });
});

// Complete setup
app.post("/api/complete-setup", async (c) => {
  const config = getConfig();
  if (!config) return c.json({ success: false, error: "No config found" }, 400);

  config.setup_complete = true;
  saveConfig(config);

  // Generate .mcp.json
  spawnSync("bun", [join(PROJECT_ROOT, "scripts/generate-mcp-config.ts")], {
    stdio: "inherit",
  });

  // Build Touch ID helper (non-blocking, OK if it fails)
  spawnSync("bash", [join(PROJECT_ROOT, "connectors/_shared/touch-id/build.sh")], {
    stdio: "inherit",
  });

  // Create a `vault` symlink inside the repo so the user can browse it from VS Code.
  // The symlink itself is gitignored.
  const vaultLink = join(PROJECT_ROOT, "vault");
  try {
    if (existsSync(vaultLink) || lstatSync(vaultLink, { throwIfNoEntry: false } as any)) {
      unlinkSync(vaultLink);
    }
  } catch {}
  try {
    symlinkSync(config.vault.path, vaultLink, "dir");
  } catch (e) {
    console.error("Could not create vault symlink:", e);
  }

  // Shut down server after a short delay (setup is done)
  setTimeout(() => {
    // Clean up PID file
    const pidFile = join(CONFIG_DIR, "server.pid");
    if (existsSync(pidFile)) {
      try { unlinkSync(pidFile); } catch {}
    }
    process.exit(0);
  }, 2000);

  return c.json({ success: true });
});

// --- Static UI ---

// Serve a minimal setup page
app.get("/setup", (c) => {
  return c.html(SETUP_HTML);
});

app.get("/", (c) => {
  if (!isSetupComplete()) return c.redirect("/setup");
  return c.html(DASHBOARD_HTML);
});

// --- Start ---

console.log(`personal-OS server running at http://localhost:${PORT}`);
export default { port: PORT, fetch: app.fetch };

// --- Inline HTML (minimal UI, no build step) ---

const SETUP_HTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>personal-OS Setup</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'JetBrains Mono', monospace; background: #0A0A0A; color: #F4F4F0; min-height: 100vh; display: flex; justify-content: center; align-items: center; }
  .container { max-width: 560px; width: 100%; padding: 40px; }
  h1 { font-size: 28px; margin-bottom: 4px; color: #F4F4F0; font-weight: 700; letter-spacing: -1px; }
  h1 .accent { color: #D80B16; }
  .subtitle { color: #AAAAAA; margin-bottom: 32px; font-size: 13px; letter-spacing: 3px; text-transform: uppercase; }
  .step { display: none; }
  .step.active { display: block; }
  h2 { font-size: 16px; font-weight: 700; letter-spacing: -0.5px; color: #F4F4F0; }
  h3 { font-weight: 500; }
  label { display: block; font-size: 12px; color: #AAAAAA; margin-bottom: 6px; margin-top: 16px; letter-spacing: 0.5px; }
  input, select { width: 100%; padding: 10px 12px; background: #111; border: 1px solid #2A2A2A; border-radius: 4px; color: #F4F4F0; font-size: 13px; font-family: inherit; }
  input:focus { outline: none; border-color: #D80B16; }
  .hint { background: #111; border: 1px solid #2A2A2A; border-left: 3px solid #D80B16; border-radius: 0 4px 4px 0; padding: 12px 14px; margin-bottom: 14px; color: #AAAAAA; font-size: 12px; line-height: 1.6; }
  .hint code { background: #0A0A0A; padding: 1px 6px; border-radius: 2px; color: #F4F4F0; font-size: 11px; }
  .btn { display: inline-block; padding: 10px 24px; background: #D80B16; color: #F4F4F0; border: none; border-radius: 4px; font-size: 13px; font-family: inherit; font-weight: 500; cursor: pointer; margin-top: 24px; letter-spacing: 0.5px; transition: background 0.15s, opacity 0.15s; }
  .btn:hover:not(:disabled) { background: #ff1a27; }
  .btn:disabled { background: #1A1A1A; color: #555; cursor: not-allowed; opacity: 0.7; }
  .btn.done { background: #1A1A1A; color: #4ade80; border: 1px solid #2A2A2A; cursor: not-allowed; opacity: 1; }
  .btn-secondary { background: #1A1A1A; border: 1px solid #2A2A2A; }
  .btn-secondary:hover:not(:disabled) { background: #222; }
  .btn[hidden] { display: none; }
  a { color: #D80B16; }
  a:hover { color: #ff1a27; }
  .next-steps { list-style: none; padding: 0; margin-top: 8px; }
  .next-steps > li { padding: 10px 0; color: #F4F4F0; font-size: 13px; line-height: 1.5; display: flex; align-items: flex-start; gap: 10px; }
  .next-steps input[type="checkbox"] { margin-top: 3px; width: 14px; height: 14px; accent-color: #D80B16; cursor: pointer; flex-shrink: 0; }
  .next-steps label { display: inline; margin: 0; color: #F4F4F0; cursor: pointer; font-size: 13px; }
  .next-steps .sub { list-style: none; padding-left: 24px; margin-top: 6px; }
  .next-steps .sub li { padding: 4px 0; color: #AAAAAA; font-size: 12px; display: flex; align-items: center; gap: 8px; }
  .next-steps code { background: #111; padding: 1px 6px; border-radius: 2px; color: #F4F4F0; font-size: 11px; }
  .next-steps li.checked > label { color: #555; text-decoration: line-through; }
  .section { background: #111; border: 1px solid #2A2A2A; border-radius: 4px; padding: 24px; margin-bottom: 16px; }
  .success { color: #4ade80; font-size: 16px; text-align: center; margin-top: 20px; }
  .steps-indicator { display: flex; gap: 8px; margin-bottom: 24px; }
  .steps-indicator .dot { width: 6px; height: 6px; border-radius: 50%; background: #2A2A2A; }
  .steps-indicator .dot.active { background: #D80B16; }
  .steps-indicator .dot.done { background: #F4F4F0; }
  p { font-size: 13px; }
</style>
</head><body>
<div class="container">
  <h1>cyb<span class="accent">.</span>OS Lite</h1>
  <p class="subtitle">// setup</p>
  <div class="steps-indicator">
    <div class="dot active" id="dot-1"></div>
    <div class="dot" id="dot-2"></div>
    <div class="dot" id="dot-tg" style="display:none"></div>
    <div class="dot" id="dot-3"></div>
  </div>

  <!-- Step 1: Vault -->
  <div class="step active" id="step-1">
    <div class="section">
      <h2>Data Vault Location</h2>
      <p style="color:#888; margin-bottom:12px">Where to store your personal data (never synced to git)</p>
      <label>Vault Path</label>
      <div style="display:flex; gap:8px; align-items:center">
        <input id="vault_path" value="~/personal-OS-vault" style="flex:1">
        <button class="btn btn-secondary" onclick="pickFolder()" style="margin-top:0; padding:10px 16px; white-space:nowrap" id="browse-btn">Browse</button>
      </div>
      <p style="color:#666; font-size:12px; margin-top:6px">Click Browse to select a folder or type a path. Folder will be created if it doesn't exist.</p>
    </div>
    <button class="btn" onclick="saveVault()">Next</button>
  </div>

  <!-- Step 2: Connectors -->
  <div class="step" id="step-2">
    <div class="section">
      <h2>Custom Connectors</h2>
      <p style="color:#888; margin-bottom:16px">These require API keys or local setup</p>

      <h3 style="margin-top:16px; color:#fff">Telegram</h3>
      <label>API ID <a href="https://my.telegram.org/apps" target="_blank" style="color:#4a9eff">(get it here)</a></label>
      <input id="tg_api_id" placeholder="12345678">
      <label>API Hash</label>
      <input id="tg_api_hash" placeholder="abc123..." type="password">

      <h3 style="margin-top:24px; color:#fff">Granola</h3>
      <p style="color:#888; font-size:13px; margin-bottom:8px">Optional. Fetches meeting notes, summaries, and transcripts from Granola via API.</p>
      <label>API Key <a href="https://docs.granola.ai/introduction" target="_blank" style="color:#4a9eff">(how to get it)</a></label>
      <input id="granola_api_key" placeholder="grn_..." type="password">
      <p style="color:#666; font-size:12px; margin-top:4px">Open Granola app → Settings → API → Create new key.</p>

      <h3 style="margin-top:24px; color:#fff">Google Workspace (Gmail + Calendar + Docs/Sheets/Slides)</h3>
      <p style="color:#888; font-size:13px; margin-bottom:8px">Reads/drafts emails, reads + creates calendar events (writes need your approval), and reads Google Docs, Sheets, and Slides. Requires a Google Cloud project.</p>
      <div class="hint">
        <strong>Setup:</strong> Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color:#cfe6ff">Google Cloud Console</a> → Create OAuth 2.0 Client ID (<strong>Web application</strong> type). Add <code>http://localhost:3847/api/gmail/callback</code> as an authorized redirect URI.<br><br>
        <strong>Enable all five APIs</strong> in the API Library (this connector needs them all — auth will fail to grant the scopes otherwise):
        <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" style="color:#cfe6ff">Gmail</a>,
        <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" style="color:#cfe6ff">Calendar</a>,
        <a href="https://console.cloud.google.com/apis/library/docs.googleapis.com" target="_blank" style="color:#cfe6ff">Docs</a>,
        <a href="https://console.cloud.google.com/apis/library/sheets.googleapis.com" target="_blank" style="color:#cfe6ff">Sheets</a>, and
        <a href="https://console.cloud.google.com/apis/library/slides.googleapis.com" target="_blank" style="color:#cfe6ff">Slides</a>.<br><br>
        On the consent screen, <strong>approve every requested scope</strong> (Docs/Sheets/Slides read-only + calendar events). If you previously authorized with fewer scopes, click "Authorize Gmail" again to re-consent and mint a new token.
      </div>
      <label>OAuth Client ID</label>
      <input id="gmail_client_id" placeholder="123456789.apps.googleusercontent.com">
      <label>OAuth Client Secret</label>
      <input id="gmail_client_secret" placeholder="GOCSPX-..." type="password">
      <div id="gmail-auth-section" style="display:none; margin-top:12px">
        <button class="btn" onclick="startGmailAuth()" id="gmail-auth-btn" type="button" style="margin-top:8px">Authorize Gmail</button>
        <p id="gmail-auth-status" style="margin-top:8px; display:none"></p>
      </div>
      <p style="color:#666; font-size:12px; margin-top:4px">After entering Client ID and Secret, click "Authorize Gmail" to complete the OAuth flow.</p>

      <h3 style="margin-top:24px; color:#fff">Twitter</h3>
      <p style="color:#888; font-size:13px; margin-bottom:8px">Reads your home timeline (tweets from accounts you follow). Requires browser cookies.</p>
      <div class="hint">
        <strong>How to get cookies:</strong> Open <a href="https://x.com" target="_blank" style="color:#cfe6ff">x.com</a> in your browser → DevTools (F12) → Application tab → Cookies → <code>https://x.com</code>. Copy the values of <code>auth_token</code> and <code>ct0</code>.
      </div>
      <label>auth_token cookie</label>
      <input id="twitter_auth_token" placeholder="paste auth_token value" type="password">
      <label>ct0 cookie</label>
      <input id="twitter_ct0" placeholder="paste ct0 value" type="password">
      <p style="color:#666; font-size:12px; margin-top:4px">Stored in macOS Keychain, never in plaintext. Use a dedicated Twitter account — not your main one.</p>

      <h3 style="margin-top:24px; color:#fff">Slack</h3>
      <p style="color:#888; font-size:13px; margin-bottom:8px">Optional. Reads channels, messages, and threads, and posts messages. Requires a Slack app with a bot token.</p>
      <div class="hint">
        <strong>Setup:</strong> Go to <a href="https://api.slack.com/apps" target="_blank" style="color:#cfe6ff">api.slack.com/apps</a> → Create New App → From scratch → pick your workspace. Under <strong>OAuth &amp; Permissions</strong>, add these Bot Token scopes: <code>channels:read</code>, <code>groups:read</code>, <code>channels:history</code>, <code>groups:history</code>, <code>chat:write</code>, <code>users:read</code>. Then click <strong>Install to Workspace</strong> and copy the <code>xoxb-</code> token.<br><br>
        The bot must be invited to any channel it reads or posts in (<code>/invite @your-app</code>).<br><br>
        <strong>Search (optional):</strong> message search needs a <strong>user</strong> token. Add a <code>search:read</code> User Token scope, reinstall, and paste the <code>xoxp-</code> token below.
      </div>
      <label>Bot Token (xoxb-…)</label>
      <input id="slack_bot_token" placeholder="xoxb-..." type="password">
      <label>User Token (xoxp-…) — optional, enables search</label>
      <input id="slack_user_token" placeholder="xoxp-..." type="password">
      <p style="color:#666; font-size:12px; margin-top:4px">Stored in macOS Keychain, never in plaintext.</p>
    </div>

    <button class="btn-secondary btn" onclick="nextStep(1)">Back</button>
    <button class="btn" onclick="saveConnectors()">Next</button>
  </div>

  <!-- Step TG: Telegram Authentication (conditional) -->
  <div class="step" id="step-tg">
    <div class="section">
      <h2>Telegram Login</h2>
      <p style="color:#888; margin-bottom:16px">Sign in to your Telegram account. Your session is stored securely in macOS Keychain.</p>

      <div id="tg-step-phone">
        <label>Phone number (with country code)</label>
        <input id="tg_phone" placeholder="+1234567890">
        <button class="btn" onclick="sendTgCode()" id="tg-send-btn">Send Code</button>
        <p id="tg-error" style="color:#f87171; margin-top:12px; display:none"></p>
      </div>

      <div id="tg-step-code" style="display:none">
        <p style="color:#4ade80; margin-bottom:8px">Code sent. Check Telegram on your phone.</p>
        <label>Login code</label>
        <input id="tg_code" placeholder="12345">
        <button class="btn" onclick="verifyTgCode()" id="tg-verify-btn">Verify</button>
        <p id="tg-code-error" style="color:#f87171; margin-top:12px; display:none"></p>
      </div>

      <div id="tg-step-password" style="display:none">
        <p style="color:#fbbf24; margin-bottom:8px">Two-factor authentication is enabled.</p>
        <label>2FA password</label>
        <input id="tg_password" type="password">
        <button class="btn" onclick="verifyTgPassword()" id="tg-pwd-btn">Submit</button>
        <p id="tg-pwd-error" style="color:#f87171; margin-top:12px; display:none"></p>
      </div>

      <div id="tg-step-done" style="display:none">
        <p style="color:#4ade80; font-size:18px; text-align:center; padding:16px">✓ Telegram authenticated</p>
      </div>
    </div>
    <button class="btn-secondary btn" onclick="nextStep(2)">Back</button>
    <button class="btn" onclick="nextStep(3)" id="tg-continue-btn" style="display:none">Continue</button>
    <button class="btn btn-secondary" onclick="skipTgAuth()" id="tg-skip-btn">Skip for now</button>
  </div>

  <!-- Step 3: Complete -->
  <div class="step" id="step-3">
    <div class="section" id="review-section">
      <h2>Review</h2>
      <div id="review-summary"></div>
    </div>
    <button class="btn-secondary btn" id="back-btn" onclick="nextStep(tgAuthRequired ? 'tg' : 2)">Back</button>
    <button class="btn" id="complete-btn" onclick="completeSetup()">Complete Setup</button>
    <div id="success-msg"></div>
  </div>
</div>

<script>
  let currentStep = 1;
  let tgAuthRequired = false;

  function nextStep(n) {
    document.getElementById('step-' + currentStep).classList.remove('active');
    document.getElementById('step-' + n).classList.add('active');

    const order = tgAuthRequired ? [1, 2, 'tg', 3] : [1, 2, 3];
    const currentIdx = order.indexOf(n);
    for (const id of order) {
      const dot = document.getElementById('dot-' + id);
      if (!dot) continue;
      const idx = order.indexOf(id);
      dot.className = 'dot' + (idx < currentIdx ? ' done' : idx === currentIdx ? ' active' : '');
    }

    currentStep = n;
    if (n === 3) showReview();
  }

  async function pickFolder() {
    const btn = document.getElementById('browse-btn');
    btn.disabled = true; btn.textContent = 'Opening...';
    try {
      const res = await fetch('/api/pick-folder');
      const data = await res.json();
      if (data.success) {
        document.getElementById('vault_path').value = data.path;
      }
    } catch {}
    btn.disabled = false; btn.textContent = 'Browse';
  }

  async function saveVault() {
    const data = { vault_path: document.getElementById('vault_path').value };
    await fetch('/api/vault', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
    nextStep(2);
  }

  let gmailAuthorized = false;

  // Show Gmail auth button when both fields have values
  function checkGmailFields() {
    const clientId = document.getElementById('gmail_client_id').value.trim();
    const clientSecret = document.getElementById('gmail_client_secret').value.trim();
    const section = document.getElementById('gmail-auth-section');
    section.style.display = (clientId && clientSecret) ? 'block' : 'none';
  }
  document.getElementById('gmail_client_id').addEventListener('input', checkGmailFields);
  document.getElementById('gmail_client_secret').addEventListener('input', checkGmailFields);

  // Listen for OAuth callback message from popup
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'gmail-auth-done') {
      gmailAuthorized = true;
      const status = document.getElementById('gmail-auth-status');
      status.style.display = 'block';
      status.style.color = '#4ade80';
      status.textContent = 'Gmail authorized successfully';
      document.getElementById('gmail-auth-btn').textContent = 'Authorized';
      document.getElementById('gmail-auth-btn').classList.add('done');
      document.getElementById('gmail-auth-btn').disabled = true;
    }
  });

  async function startGmailAuth() {
    const clientId = document.getElementById('gmail_client_id').value.trim();
    const clientSecret = document.getElementById('gmail_client_secret').value.trim();
    if (!clientId || !clientSecret) return;

    // Store credentials first
    await fetch('/api/secrets', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ connector: 'gmail', key: 'GMAIL_CLIENT_ID', value: clientId }) });
    await fetch('/api/secrets', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ connector: 'gmail', key: 'GMAIL_CLIENT_SECRET', value: clientSecret }) });

    // Get auth URL and open in popup
    const res = await fetch('/api/gmail/auth-url?client_id=' + encodeURIComponent(clientId));
    const data = await res.json();
    if (data.url) {
      window.open(data.url, 'gmail-auth', 'width=600,height=700');
    }
  }

  async function saveConnectors() {
    const tgId = document.getElementById('tg_api_id').value;
    const tgHash = document.getElementById('tg_api_hash').value;

    if (tgId && tgHash) {
      await fetch('/api/secrets', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ connector: 'telegram', key: 'TELEGRAM_API_ID', value: tgId }) });
      await fetch('/api/secrets', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ connector: 'telegram', key: 'TELEGRAM_API_HASH', value: tgHash }) });
    }

    const granolaKey = document.getElementById('granola_api_key').value.trim();
    if (granolaKey) {
      await fetch('/api/secrets', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ connector: 'granola', key: 'GRANOLA_API_KEY', value: granolaKey }) });
    }

    // Gmail credentials are already stored during auth flow
    const gmailClientId = document.getElementById('gmail_client_id').value.trim();
    const gmailClientSecret = document.getElementById('gmail_client_secret').value.trim();
    if (gmailClientId && gmailClientSecret && !gmailAuthorized) {
      // Store credentials even if OAuth wasn't completed (user can auth later)
      await fetch('/api/secrets', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ connector: 'gmail', key: 'GMAIL_CLIENT_ID', value: gmailClientId }) });
      await fetch('/api/secrets', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ connector: 'gmail', key: 'GMAIL_CLIENT_SECRET', value: gmailClientSecret }) });
    }

    const twAuthToken = document.getElementById('twitter_auth_token').value.trim();
    const twCt0 = document.getElementById('twitter_ct0').value.trim();
    if (twAuthToken && twCt0) {
      await fetch('/api/secrets', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ connector: 'twitter', key: 'TWITTER_AUTH_TOKEN', value: twAuthToken }) });
      await fetch('/api/secrets', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ connector: 'twitter', key: 'TWITTER_CT0', value: twCt0 }) });
    }

    const slackBotToken = document.getElementById('slack_bot_token').value.trim();
    const slackUserToken = document.getElementById('slack_user_token').value.trim();
    if (slackBotToken) {
      await fetch('/api/secrets', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ connector: 'slack', key: 'SLACK_BOT_TOKEN', value: slackBotToken }) });
    }
    if (slackUserToken) {
      await fetch('/api/secrets', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ connector: 'slack', key: 'SLACK_USER_TOKEN', value: slackUserToken }) });
    }

    const gmailEnabled = !!(gmailClientId && gmailClientSecret && gmailAuthorized);

    await fetch('/api/connectors', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        custom_connectors: {
          telegram: { enabled: !!tgId, version: '1.0.0' },
          twitter: { enabled: !!(twAuthToken && twCt0), version: '2.0.0' },
          gmail: { enabled: gmailEnabled, version: '1.0.0' },
          granola: { enabled: !!granolaKey, version: '3.0.0' },
          slack: { enabled: !!slackBotToken, version: '1.0.0' }
        },
        builtin_mcps: {
          typefully: { required: true, connected: false },
          notion: { required: false, connected: false }
        }
      })
    });

    // If Telegram is configured, route through the auth step
    if (tgId && tgHash) {
      tgAuthRequired = true;
      document.getElementById('dot-tg').style.display = 'block';
      nextStep('tg');
    } else {
      nextStep(3);
    }
  }

  // --- Telegram in-wizard auth ---
  function showTgError(elId, msg) {
    const el = document.getElementById(elId);
    el.textContent = msg;
    el.style.display = 'block';
  }

  async function sendTgCode() {
    const phone = document.getElementById('tg_phone').value.trim();
    const tgId = document.getElementById('tg_api_id').value;
    const tgHash = document.getElementById('tg_api_hash').value;
    if (!phone) return showTgError('tg-error', 'Phone number required');

    const btn = document.getElementById('tg-send-btn');
    btn.disabled = true; btn.textContent = 'Sending...';
    document.getElementById('tg-error').style.display = 'none';

    const res = await fetch('/api/telegram/send-code', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ phone, api_id: tgId, api_hash: tgHash }),
    });
    const data = await res.json();

    if (data.success) {
      // Keep button locked — section will be hidden, but guard against re-entry
      btn.textContent = 'Code sent ✓';
      btn.classList.add('done');
      document.getElementById('tg_phone').disabled = true;
      document.getElementById('tg-step-phone').style.display = 'none';
      document.getElementById('tg-step-code').style.display = 'block';
    } else {
      btn.disabled = false; btn.textContent = 'Send Code';
      showTgError('tg-error', data.error || 'Failed to send code');
    }
  }

  async function verifyTgCode() {
    const code = document.getElementById('tg_code').value.trim();
    if (!code) return showTgError('tg-code-error', 'Code required');

    const btn = document.getElementById('tg-verify-btn');
    btn.disabled = true; btn.textContent = 'Verifying...';
    document.getElementById('tg-code-error').style.display = 'none';

    const res = await fetch('/api/telegram/verify-code', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    btn.disabled = false; btn.textContent = 'Verify';

    if (data.success) {
      showTgDone();
    } else if (data.needsPassword) {
      document.getElementById('tg-step-code').style.display = 'none';
      document.getElementById('tg-step-password').style.display = 'block';
    } else {
      showTgError('tg-code-error', data.error || 'Invalid code');
    }
  }

  async function verifyTgPassword() {
    const password = document.getElementById('tg_password').value;
    if (!password) return showTgError('tg-pwd-error', '2FA password required');

    const btn = document.getElementById('tg-pwd-btn');
    btn.disabled = true; btn.textContent = 'Verifying...';
    document.getElementById('tg-pwd-error').style.display = 'none';

    const res = await fetch('/api/telegram/verify-password', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    btn.disabled = false; btn.textContent = 'Submit';

    if (data.success) {
      showTgDone();
    } else {
      showTgError('tg-pwd-error', data.error || 'Wrong password');
    }
  }

  function showTgDone() {
    document.getElementById('tg-step-phone').style.display = 'none';
    document.getElementById('tg-step-code').style.display = 'none';
    document.getElementById('tg-step-password').style.display = 'none';
    document.getElementById('tg-step-done').style.display = 'block';
    document.getElementById('tg-continue-btn').style.display = 'inline-block';
    document.getElementById('tg-skip-btn').style.display = 'none';
  }

  function skipTgAuth() {
    nextStep(3);
  }

  function showReview() {
    const vault = document.getElementById('vault_path').value;
    const tg = document.getElementById('tg_api_id').value ? 'Configured' : 'Skipped';
    const gmail = gmailAuthorized ? 'Authorized (Gmail + Calendar + Docs/Sheets/Slides)' : (document.getElementById('gmail_client_id').value ? 'Credentials set (not authorized)' : 'Not configured');
    const tw = (document.getElementById('twitter_auth_token').value && document.getElementById('twitter_ct0').value) ? 'Cookies set' : 'Not configured';
    const granola = document.getElementById('granola_api_key').value ? 'API key set' : 'Not configured';
    const slackBot = document.getElementById('slack_bot_token').value;
    const slack = slackBot ? (document.getElementById('slack_user_token').value ? 'Bot + user token set' : 'Bot token set') : 'Not configured';

    document.getElementById('review-summary').innerHTML =
      '<p><strong>Vault:</strong> ' + vault + '</p>' +
      '<p><strong>Telegram:</strong> ' + tg + '</p>' +
      '<p><strong>Google:</strong> ' + gmail + '</p>' +
      '<p><strong>Twitter:</strong> ' + tw + '</p>' +
      '<p><strong>Granola:</strong> ' + granola + '</p>' +
      '<p><strong>Slack:</strong> ' + slack + '</p>' +
      '<p style="color:#888; margin-top:12px">After setup, connect Typefully via <code>/mcp</code> in Claude Code.</p>';
  }

  async function completeSetup() {
    const completeBtn = document.getElementById('complete-btn');
    const backBtn = document.getElementById('back-btn');

    // Lock both buttons immediately so the user can't double-submit or go back mid-flight
    completeBtn.disabled = true;
    completeBtn.textContent = 'Completing...';
    backBtn.disabled = true;

    const res = await fetch('/api/complete-setup', { method: 'POST' });

    if (res.ok) {
      // Permanent locked state
      completeBtn.textContent = 'Completed ✓';
      completeBtn.classList.add('done');
      backBtn.hidden = true;

      document.getElementById('success-msg').innerHTML =
        '<div class="section" style="margin-top:16px">' +
          '<h2>Next steps</h2>' +
          '<p style="color:#888; margin-bottom:12px">Tick these off as you go.</p>' +
          '<ul class="next-steps" id="next-steps-list">' +
            '<li><input type="checkbox" id="ns-1"><label for="ns-1">Run <code>/exit</code> in Claude Code to close the current session.</label></li>' +
            '<li><input type="checkbox" id="ns-2"><label for="ns-2">Start Claude Code again (<code>claude</code>) so it picks up the new config.</label></li>' +
            '<li><input type="checkbox" id="ns-3"><label for="ns-3">Run <code>/cyber-setup</code> in Claude Code to initialize your vault, profile, and writing style.</label></li>' +
            '<li>' +
              '<input type="checkbox" id="ns-4"><label for="ns-4">Connect MCP servers — run <code>/mcp</code> and add:</label>' +
              '<ul class="sub">' +
                '<li><input type="checkbox" id="ns-4a"><label for="ns-4a"><a href="https://support.typefully.com/en/articles/13128440-typefully-mcp-server" target="_blank" style="color:#4a9eff">Typefully</a></label></li>' +
                '<li><input type="checkbox" id="ns-4b"><label for="ns-4b"><a href="https://developers.notion.com/guides/mcp/get-started-with-mcp" target="_blank" style="color:#4a9eff">Notion</a> (optional)</label></li>' +
              '</ul>' +
            '</li>' +
          '</ul>' +
        '</div>';

      // Strike-through behavior on tick
      document.querySelectorAll('#next-steps-list input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', e => {
          const li = e.target.closest('li');
          if (li) li.classList.toggle('checked', e.target.checked);
        });
      });
    } else {
      // Allow retry on failure
      completeBtn.disabled = false;
      completeBtn.textContent = 'Complete Setup';
      backBtn.disabled = false;
    }
  }
</script>
</body></html>`;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><title>personal-OS</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'JetBrains Mono', monospace; background: #0A0A0A; color: #F4F4F0; padding: 40px; max-width: 560px; margin: 0 auto; }
  h1 { font-size: 28px; font-weight: 700; letter-spacing: -1px; margin-bottom: 4px; }
  h1 .accent { color: #D80B16; }
  .subtitle { color: #AAAAAA; margin-bottom: 32px; font-size: 13px; letter-spacing: 3px; text-transform: uppercase; }
  .card { background: #111; border: 1px solid #2A2A2A; border-radius: 4px; padding: 20px; margin-bottom: 12px; }
  .card h3 { font-size: 14px; font-weight: 700; margin-bottom: 8px; color: #F4F4F0; }
  .card p { font-size: 13px; color: #AAAAAA; line-height: 1.5; }
  code { background: #0A0A0A; padding: 1px 6px; border-radius: 2px; color: #F4F4F0; font-size: 11px; }
  a { color: #D80B16; }
</style>
</head><body>
<h1>cyb<span class="accent">.</span>OS Lite</h1>
<p class="subtitle">// dashboard</p>
<div class="card"><h3>Setup complete</h3><p>Use Claude Code to interact with your workspace.</p></div>
<div class="card"><h3>Skills</h3><p>/cyber-brief, /cyber-telegram, /cyber-email, /cyber-calendar, /cyber-save-calls, /cyber-schedule</p></div>
<div class="card"><h3>Update</h3><p>Run <code>/cyber-update</code> in Claude Code to pull latest skills.</p></div>
</body></html>`;
