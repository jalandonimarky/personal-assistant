import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as keychain from "./keychain.mjs";

const run = promisify(execFile);

/**
 * Per-user delegated auth against Google APIs, shared by the Gmail and Drive
 * servers.
 *
 * WHY THIS EXISTS RATHER THAN THE claude.ai CONNECTOR. The account connector
 * works, but it is owned by the Claude account rather than by this app: on a
 * machine that has never authorised it there is nothing local to fix, and the
 * person has to go enable it on the web first. Signing in here is the same
 * shape as the Outlook server — each person signs in as themselves, and reaches
 * only their own mail and files. The isolation is the token, not our code.
 *
 * Public client + PKCE. Google issues a "client secret" for Desktop app
 * clients, and its own documentation is explicit that the value is not treated
 * as confidential for installed apps — it is sent when configured, but PKCE is
 * what actually binds the code to this request.
 *
 * The refresh token lives in the macOS Keychain: never on disk in the repo,
 * never in store.json, never on argv.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

/** Identifies the signed-in account in the UI; costs nothing else. */
export const IDENTITY_SCOPES = ["openid", "email"];

/** Where the OAuth client is kept when it wasn't supplied by the environment. */
export const CLIENT_ID_SERVICE = "google-oauth-client-id";
export const CLIENT_SECRET_SERVICE = "google-oauth-client-secret";

/**
 * @param service  keychain service name, unique per Google server
 * @param scopes   OAuth scopes this server needs
 * @param port     loopback port for the redirect
 *
 * The client id comes from the environment if it is there, and otherwise from
 * the Keychain. THE KEYCHAIN PATH IS THE IMPORTANT ONE: this app normally runs
 * as a launchd agent, which has no interactive shell to export a variable into
 * — telling someone to "set GOOGLE_CLIENT_ID in the shell running this app" is
 * advice they cannot act on. Settings writes it here instead.
 */
export async function makeConfig({ service, scopes, port }) {
  const clientId =
    process.env.GOOGLE_CLIENT_ID || (await keychain.get(CLIENT_ID_SERVICE));
  if (!clientId) {
    throw new Error(
      "No Google OAuth client configured. Add one in Settings → Connections, " +
        "or see mcp/google/README.md.",
    );
  }
  return {
    service,
    scopes: [...IDENTITY_SCOPES, ...scopes],
    clientId,
    // Optional: absent for client types that do not issue one.
    clientSecret:
      process.env.GOOGLE_CLIENT_SECRET || (await keychain.get(CLIENT_SECRET_SERVICE)) || null,
    port: Number(process.env[`${service.toUpperCase().replace(/-/g, "_")}_PORT`] || port),
    account: process.env.GOOGLE_ACCOUNT || "default",
  };
}

/** Is an OAuth client configured at all? Used by the panel before offering sign-in. */
export async function clientConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID || (await keychain.get(CLIENT_ID_SERVICE)));
}

// ---------------- PKCE ----------------

const b64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pkce() {
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

const page = (title, msg) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px -apple-system,sans-serif;padding:60px;text-align:center;color:#46413a">` +
  `<h2 style="color:#1f1d19">${title}</h2><p>${msg}</p></body>`;

/** Wait for the redirect and hand back the authorization code. */
function awaitCode(port, expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error =
        url.searchParams.get("error_description") || url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "content-type": "text/html" }).end(page("Sign-in failed", error));
        server.close();
        reject(new Error(error));
        return;
      }
      /**
       * Guards against another site's redirect completing this flow — but in
       * practice the common cause is far duller: an earlier sign-in tab, left
       * open from a previous attempt, being approved after a new attempt has
       * started. Its state belongs to the old request. Say so, because "state
       * mismatch" alone reads as a bug in the app.
       */
      if (state !== expectedState) {
        const why =
          "This response belongs to an earlier sign-in attempt. Close any other " +
          "Google sign-in tabs, then press Sign in again and use only the tab it opens.";
        res.writeHead(400, { "content-type": "text/html" }).end(page("Sign-in failed", why));
        server.close();
        reject(new Error(why));
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(page("Signed in", "You can close this tab and return to the assistant."));
      server.close();
      resolve(code);
    });

    // A previous attempt still holding the port would otherwise take this
    // redirect and reject it as a state mismatch, blaming the wrong thing.
    server.on("error", (e) =>
      reject(
        e.code === "EADDRINUSE"
          ? new Error(
              `Port ${port} is already in use by an earlier sign-in. Wait a moment for it to ` +
                `time out, or close any half-finished sign-in, then try again.`,
            )
          : e,
      ),
    );
    // Loopback only — this listener must never be reachable off-machine.
    server.listen(port, "127.0.0.1");
    setTimeout(() => {
      server.close();
      reject(new Error("Sign-in timed out after 5 minutes."));
    }, 300_000);
  });
}

async function tokenRequest(cfg, params) {
  const body = new URLSearchParams({ client_id: cfg.clientId, ...params });
  if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error_description || json.error || `token endpoint ${res.status}`);
  }
  return json;
}

/**
 * Interactive sign-in. Stores the refresh token.
 *
 * `openBrowser: false` prints the URL instead of launching one. That is what
 * the app uses: `open` starts the SYSTEM default browser, which is often not
 * the browser the assistant is being used in — so the page opens the URL
 * itself and the sign-in stays where the person already is. The loopback
 * listener does not care which browser arrives.
 */
export async function login(cfg, { openBrowser = true } = {}) {
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  // 127.0.0.1, not localhost. Google matches redirect URIs as exact strings,
  // so the two are different registrations — and 127.0.0.1 is the form Google
  // documents for loopback, so it is the one people register.
  const redirectUri = `http://127.0.0.1:${cfg.port}/callback`;

  const url =
    `${AUTH_ENDPOINT}?` +
    new URLSearchParams({
      client_id: cfg.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: cfg.scopes.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      // Without both of these Google returns a refresh token on the FIRST
      // consent only, so a second sign-in silently yields none and the server
      // can never refresh again.
      access_type: "offline",
      prompt: "consent",
    });

  const waiting = awaitCode(cfg.port, state);
  if (openBrowser) {
    await run("open", [url]).catch(() => {
      process.stdout.write(`Open this URL to sign in:\n${url}\n`);
    });
  } else {
    // Printed on stdout so the caller can capture and surface it.
    process.stdout.write(`${url}\n`);
  }

  const code = await waiting;
  const tok = await tokenRequest(cfg, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  if (!tok.refresh_token) {
    throw new Error("No refresh token returned — revoke the app's access in your Google account and sign in again.");
  }
  await keychain.set(cfg.service, tok.refresh_token, cfg.account);
  return tok.access_token;
}

export async function logout(cfg) {
  return keychain.del(cfg.service, cfg.account);
}

/** A usable access token, refreshed silently. Throws NOT_AUTHENTICATED if absent. */
export async function accessToken(cfg) {
  const refresh = await keychain.get(cfg.service, cfg.account);
  if (!refresh) {
    const e = new Error("Not signed in to Google.");
    e.code = "NOT_AUTHENTICATED";
    throw e;
  }
  const tok = await tokenRequest(cfg, {
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
  // Google does not rotate refresh tokens, but persist one if it ever appears.
  if (tok.refresh_token) await keychain.set(cfg.service, tok.refresh_token, cfg.account);
  return tok.access_token;
}

/** Which account is signed in — shown in the Connections panel. */
export async function whoami(cfg) {
  const token = await accessToken(cfg);
  const res = await fetch(USERINFO, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const json = await res.json();
  return json.email ?? null;
}

/** Authorised GET/POST against a Google API, returning parsed JSON. */
export async function api(cfg, url, init = {}) {
  const token = await accessToken(cfg);
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body && !init.headers?.["content-type"]
        ? { "content-type": "application/json" }
        : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      message = JSON.parse(text).error?.message ?? text;
    } catch {
      /* not JSON — use the raw body */
    }
    throw new Error(`${res.status}: ${message}`.slice(0, 500));
  }
  return res.status === 204 ? {} : res.json();
}

/** Same, for endpoints that return a file body rather than JSON. */
export async function apiText(cfg, url) {
  const token = await accessToken(cfg);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.text();
}

/**
 * Shared CLI surface. Every server exposes the same three verbs, which is what
 * the Connections panel drives: --login, --logout, --status.
 */
export async function runCli(cfg, label, arg, opts = {}) {
  if (arg === "--login") {
    await login(cfg, opts);
    const who = await whoami(cfg).catch(() => null);
    console.log(`Signed in to ${label}${who ? ` as ${who}` : ""}.`);
    return true;
  }
  if (arg === "--logout") {
    const had = await logout(cfg);
    console.log(had ? `Signed out of ${label}.` : `Was not signed in to ${label}.`);
    return true;
  }
  if (arg === "--status") {
    try {
      const who = await whoami(cfg);
      console.log(JSON.stringify({ signedIn: Boolean(who), account: who }, null, 2));
    } catch {
      console.log(JSON.stringify({ signedIn: false }, null, 2));
      process.exitCode = 1;
    }
    return true;
  }
  return false;
}
