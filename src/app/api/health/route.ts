import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const dynamic = "force-dynamic";

/**
 * Preflight for the `claude` CLI this app is a front-end for.
 *
 * Detection only. Credentials live in the macOS Keychain under
 * "Claude Code-credentials" and belong to Claude Code — this app never reads,
 * stores, or prompts for them. `claude auth status` reports state without
 * exposing any secret.
 *
 * Signing in is a separate route (src/app/api/auth). It drives the CLI's own
 * `claude auth login` rather than handling credentials here, so the invariant
 * above still holds: this app can start a sign-in and observe the result, but
 * never learns the token.
 */

// `next dev` can inherit a PATH without the user's npm global bin. Same fix as
// src/lib/claude.ts — keep the two in step.
const PATH_EXTRA = [
  `${process.env.HOME}/.npm-global/bin`,
  "/opt/homebrew/bin",
  "/usr/local/bin",
].join(":");

const env = { ...process.env, PATH: `${PATH_EXTRA}:${process.env.PATH ?? ""}` };

interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

export async function GET() {
  // 1. Is the CLI installed at all?
  let version: string | null = null;
  try {
    const { stdout } = await run("claude", ["--version"], { env, timeout: 15000 });
    version = stdout.trim() || null;
  } catch {
    return NextResponse.json({
      installed: false,
      loggedIn: false,
      remedy:
        "Claude Code isn't on this machine's PATH. Install it, then reload:\n\nnpm install -g @anthropic-ai/claude-code",
    });
  }

  // 2. Installed — is it signed in?
  let auth: AuthStatus = {};
  try {
    const { stdout } = await run("claude", ["auth", "status"], {
      env,
      timeout: 20000,
    });
    auth = JSON.parse(stdout);
  } catch {
    return NextResponse.json({
      installed: true,
      version,
      loggedIn: false,
      remedy:
        "Claude Code is installed but not signed in. Use Sign in below, or run `claude auth login` in a terminal.",
    });
  }

  // An API key in the server's environment silently redirects billing away from
  // the subscription. Worth surfacing rather than leaving as a README warning.
  const apiKeyPresent = Boolean(process.env.ANTHROPIC_API_KEY);
  const billed = apiKeyPresent || auth.apiProvider !== "firstParty";

  return NextResponse.json({
    installed: true,
    version,
    loggedIn: auth.loggedIn ?? false,
    authMethod: auth.authMethod ?? null,
    account: auth.email ?? null,
    plan: auth.subscriptionType ?? null,
    billed,
    apiKeyPresent,
    remedy: auth.loggedIn
      ? null
      : "Claude Code is installed but not signed in. Use Sign in below, or run `claude auth login` in a terminal.",
  });
}
