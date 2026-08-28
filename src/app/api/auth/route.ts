import { NextResponse } from "next/server";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const dynamic = "force-dynamic";
// Must be a literal — an expression here fails the build.
export const maxDuration = 300;

/**
 * Signing the `claude` CLI in, from the Settings panel.
 *
 * WHY THIS IS ALLOWED TO EXIST. The rule everywhere else in this app is that
 * credentials belong to Claude Code and this app must never learn them. That
 * rule is intact here. `claude auth login` performs the OAuth exchange itself
 * and writes the result to the macOS Keychain; we only start it, show the URL
 * it prints, and hand back the short-lived AUTHORIZATION CODE the user pastes.
 * That code is single-use, useless once redeemed, and never written to disk by
 * us. We never see the access token, the refresh token, or the password.
 *
 * WHY IT WORKS WITHOUT A TERMINAL. Verified against CLI 2.1.247: with no TTY,
 * `claude auth login` still prints the authorize URL to stdout and then blocks
 * reading the code from stdin. The redirect goes to Anthropic's own callback
 * page rather than a localhost port, so there is nothing to intercept — the
 * user copies a code back. That makes the whole flow drivable from a spawned
 * process, which is what this route does.
 */

const PATH_EXTRA = [
  `${process.env.HOME}/.npm-global/bin`,
  "/opt/homebrew/bin",
  "/usr/local/bin",
].join(":");

const env = { ...process.env, PATH: `${PATH_EXTRA}:${process.env.PATH ?? ""}` };

/** How long a half-finished sign-in may sit waiting for its code. */
const PENDING_TTL_MS = 10 * 60 * 1000;
/** The URL should appear almost immediately; if it doesn't, something is wrong. */
const URL_TIMEOUT_MS = 25_000;

interface Pending {
  child: ChildProcessWithoutNullStreams;
  out: string;
  startedAt: number;
  timer: NodeJS.Timeout;
}

/**
 * A module-level map is safe HERE, unlike in store.ts. Next bundles route
 * handlers separately, so this is not shared with other routes — but every
 * step of one sign-in (start → code → cancel) lives in THIS file, so they see
 * the same instance. A dev hot-reload can still discard it mid-flow, which is
 * why an unknown id returns a "start again" message rather than an error.
 */
const pending = new Map<string, Pending>();

function discard(id: string) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  p.child.kill("SIGTERM");
  pending.delete(id);
}

/** Pull the authorize URL out of the CLI's own output. */
function findUrl(text: string): string | null {
  const m = text.match(/https:\/\/\S*oauth\S*/);
  return m ? m[0].replace(/[.,)]+$/, "") : null;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action : "";

  /* ---------------------------------------------------------------- start */

  if (action === "start") {
    // Console mode bills per token; the subscription is the whole point of this
    // app, so it is the default and --console must be asked for explicitly.
    const args = ["auth", "login", body.console === true ? "--console" : "--claudeai"];
    if (typeof body.email === "string" && body.email.trim()) {
      args.push("--email", body.email.trim());
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return NextResponse.json(
        { error: "Could not run `claude`. Is Claude Code installed and on PATH?" },
        { status: 500 },
      );
    }

    const id = `${process.pid}-${Date.now()}`;
    const entry: Pending = {
      child,
      out: "",
      startedAt: Date.now(),
      timer: setTimeout(() => discard(id), PENDING_TTL_MS),
    };
    pending.set(id, entry);

    const collect = (d: Buffer) => {
      entry.out += d.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => discard(id));

    const url = await new Promise<string | null>((resolve) => {
      const deadline = Date.now() + URL_TIMEOUT_MS;
      const tick = setInterval(() => {
        const found = findUrl(entry.out);
        if (found) {
          clearInterval(tick);
          resolve(found);
        } else if (child.exitCode !== null || Date.now() > deadline) {
          clearInterval(tick);
          resolve(null);
        }
      }, 150);
    });

    if (!url) {
      const out = entry.out.trim();
      discard(id);
      return NextResponse.json(
        {
          error:
            out ||
            "The CLI did not return a sign-in link. Try `claude auth login` in a terminal.",
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, id, url });
  }

  /* ----------------------------------------------------------------- code */

  if (action === "code") {
    const id = typeof body.id === "string" ? body.id : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const entry = pending.get(id);

    if (!entry) {
      return NextResponse.json(
        { error: "That sign-in is no longer open. Start again." },
        { status: 410 },
      );
    }
    if (!code) {
      discard(id);
      return NextResponse.json({ error: "No code provided." }, { status: 400 });
    }

    const before = entry.out.length;
    entry.child.stdin.write(`${code}\n`);

    const finished = await new Promise<{ code: number | null }>((resolve) => {
      const timer = setTimeout(() => resolve({ code: null }), 60_000);
      entry.child.once("close", (c) => {
        clearTimeout(timer);
        resolve({ code: c });
      });
    });

    const tail = entry.out.slice(before).trim();
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.child.kill("SIGTERM");

    if (finished.code === 0) {
      return NextResponse.json({ ok: true, message: "Signed in." });
    }
    return NextResponse.json(
      {
        error:
          tail ||
          "The code was not accepted. It expires quickly — generate a new one and retry.",
      },
      { status: 400 },
    );
  }

  /* --------------------------------------------------------------- cancel */

  if (action === "cancel") {
    if (typeof body.id === "string") discard(body.id);
    return NextResponse.json({ ok: true });
  }

  /* --------------------------------------------------------------- logout */

  if (action === "logout") {
    const r = await new Promise<number | null>((resolve) => {
      const child = spawn("claude", ["auth", "logout"], { env });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve(null);
      }, 30_000);
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    return r === 0
      ? NextResponse.json({ ok: true, message: "Signed out." })
      : NextResponse.json({ error: "Sign-out failed." }, { status: 500 });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
