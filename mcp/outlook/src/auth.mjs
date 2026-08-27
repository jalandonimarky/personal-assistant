import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Per-user delegated auth against Microsoft Graph.
 *
 * Public client + PKCE, deliberately: no client secret exists anywhere. A
 * secret distributed to every user's machine is a credential leak with extra
 * steps, and PKCE was designed to remove the need for one.
 *
 * The refresh token lives in the macOS Keychain — never on disk in the repo,
 * never in the app's store.json. Each user's token is their own, so each user
 * reaches only their own mailbox. The isolation is the token, not our code.
 */

const SERVICE = "outlook-mcp-refresh-token";
const SCOPES = ["offline_access", "User.Read", "Mail.Read"];

/** Config comes from the environment — the client owns the app registration. */
export function config() {
  const tenantId = process.env.OUTLOOK_TENANT_ID;
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  if (!tenantId || !clientId) {
    throw new Error(
      "OUTLOOK_TENANT_ID and OUTLOOK_CLIENT_ID must be set. See mcp/outlook/README.md.",
    );
  }
  return {
    tenantId,
    clientId,
    port: Number(process.env.OUTLOOK_REDIRECT_PORT || 53682),
    account: process.env.OUTLOOK_ACCOUNT || "default",
  };
}

const authority = (t) => `https://login.microsoftonline.com/${t}/oauth2/v2.0`;

// ---------------- Keychain ----------------

async function keychainGet(account) {
  try {
    const { stdout } = await run("security", [
      "find-generic-password", "-s", SERVICE, "-a", account, "-w",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function keychainSet(account, token) {
  // -U updates in place when the entry already exists.
  await run("security", [
    "add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", token,
  ]);
}

async function keychainDelete(account) {
  try {
    await run("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
    return true;
  } catch {
    return false;
  }
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
      const url = new URL(req.url, `http://localhost:${port}`);
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
      // Guards against another site's redirect completing this flow.
      if (state !== expectedState) {
        res.writeHead(400, { "content-type": "text/html" })
          .end(page("Sign-in failed", "State mismatch — the response did not match this request."));
        server.close();
        reject(new Error("state mismatch"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" })
        .end(page("Signed in", "You can close this tab and return to the assistant."));
      server.close();
      resolve(code);
    });

    server.on("error", reject);
    // Loopback only — this listener must never be reachable off-machine.
    server.listen(port, "127.0.0.1");
    setTimeout(() => {
      server.close();
      reject(new Error("Sign-in timed out after 5 minutes."));
    }, 300_000);
  });
}

async function tokenRequest(cfg, params) {
  const res = await fetch(`${authority(cfg.tenantId)}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, ...params }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error_description || json.error || `token endpoint ${res.status}`);
  }
  return json;
}

/** Interactive sign-in. Opens the browser and stores the refresh token. */
export async function login(cfg = config()) {
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const redirectUri = `http://localhost:${cfg.port}/callback`;

  const url =
    `${authority(cfg.tenantId)}/authorize?` +
    new URLSearchParams({
      client_id: cfg.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

  const waiting = awaitCode(cfg.port, state);
  await run("open", [url]).catch(() => {
    process.stderr.write(`Open this URL to sign in:\n${url}\n`);
  });

  const code = await waiting;
  const tok = await tokenRequest(cfg, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  if (!tok.refresh_token) {
    throw new Error("No refresh token returned — is offline_access consented?");
  }
  await keychainSet(cfg.account, tok.refresh_token);
  return tok.access_token;
}

/** A usable access token, refreshed silently. Throws NOT_AUTHENTICATED if absent. */
export async function accessToken(cfg = config()) {
  const refresh = await keychainGet(cfg.account);
  if (!refresh) {
    const e = new Error("Not signed in to Outlook.");
    e.code = "NOT_AUTHENTICATED";
    throw e;
  }
  const tok = await tokenRequest(cfg, {
    grant_type: "refresh_token",
    refresh_token: refresh,
    scope: SCOPES.join(" "),
  });
  // Microsoft rotates refresh tokens; persist the new one or the next run fails.
  if (tok.refresh_token) await keychainSet(cfg.account, tok.refresh_token);
  return tok.access_token;
}

export async function logout(cfg = config()) {
  return keychainDelete(cfg.account);
}

/** Whether this user is signed in, and as whom. Used by the app's preflight. */
export async function status(cfg = config()) {
  if (!(await keychainGet(cfg.account))) return { signedIn: false };
  try {
    const token = await accessToken(cfg);
    const res = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { signedIn: false, error: `Graph ${res.status}` };
    const me = await res.json();
    return {
      signedIn: true,
      account: me.userPrincipalName || me.mail || null,
      name: me.displayName || null,
    };
  } catch (e) {
    return { signedIn: false, error: e.message };
  }
}
