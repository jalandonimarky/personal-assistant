import { NextResponse } from "next/server";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getService } from "@/lib/services";

export const dynamic = "force-dynamic";
// Must be a literal — an expression here fails the build.
export const maxDuration = 300;

/**
 * Registers a service's MCP server, or signs the user into one.
 *
 * Both actions run a command, so the inputs are handled carefully:
 * the service id is resolved against the registry and every path, name and
 * environment value is derived server-side. The only client-supplied value
 * that reaches a process is the token, and it goes over **stdin** — argv is
 * visible in the process list and in shell history.
 */

const PATH_EXTRA = [
  `${process.env.HOME}/.npm-global/bin`,
  "/opt/homebrew/bin",
  "/usr/local/bin",
].join(":");

const env = { ...process.env, PATH: `${PATH_EXTRA}:${process.env.PATH ?? ""}` };

function exec(
  cmd: string,
  args: string[],
  stdin?: string,
  timeout = 290_000,
): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out, err: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim(), err: err.trim() });
    });

    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * Half-finished connector logins, keyed by id. Module-level state is safe here
 * for the same reason as in api/auth: routes are bundled separately so this is
 * not shared with others, but both halves of one login live in this file.
 */
const connectorLogins = new Map<
  string,
  { child: ChildProcessWithoutNullStreams; out: string; timer: NodeJS.Timeout }
>();

function dropLogin(id: string) {
  const p = connectorLogins.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  p.child.kill("SIGTERM");
  connectorLogins.delete(id);
}

async function startConnectorLogin(mcpName: string, label: string) {
  const child = spawn("claude", ["mcp", "login", mcpName, "--no-browser"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const id = `${process.pid}-${Date.now()}`;
  const entry = {
    child,
    out: "",
    timer: setTimeout(() => dropLogin(id), 10 * 60 * 1000),
  };
  connectorLogins.set(id, entry);

  const collect = (d: Buffer) => {
    entry.out += d.toString();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", () => dropLogin(id));

  const url = await new Promise<string | null>((resolve) => {
    const deadline = Date.now() + 25_000;
    const tick = setInterval(() => {
      const m = entry.out.match(/https:\/\/\S+/);
      if (m) {
        clearInterval(tick);
        resolve(m[0].replace(/[.,)]+$/, ""));
      } else if (child.exitCode !== null || Date.now() > deadline) {
        clearInterval(tick);
        resolve(null);
      }
    }, 150);
  });

  if (!url) {
    const out = entry.out.trim();
    dropLogin(id);
    return NextResponse.json(
      { error: out || `Could not start authorisation for ${label}.` },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, id, url });
}

async function finishConnectorLogin(id: string, redirect: string) {
  const entry = connectorLogins.get(id);
  if (!entry) {
    return NextResponse.json(
      { error: "That authorisation is no longer open. Start again." },
      { status: 410 },
    );
  }
  if (!redirect) {
    dropLogin(id);
    return NextResponse.json({ error: "No redirect URL provided." }, { status: 400 });
  }

  const before = entry.out.length;
  entry.child.stdin.write(`${redirect}\n`);

  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 60_000);
    entry.child.once("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });

  const tail = entry.out.slice(before).trim();
  dropLogin(id);

  return code === 0
    ? NextResponse.json({ ok: true, message: "Authorised." })
    : NextResponse.json(
        { error: tail || "Authorisation failed. Copy the whole redirect URL and retry." },
        { status: 400 },
      );
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const svc = typeof body.id === "string" ? getService(body.id) : null;
  if (!svc) return NextResponse.json({ error: "Unknown service." }, { status: 400 });
  /**
   * Account connectors have no script of ours to run, but they are not
   * un-fixable — `claude mcp login <name>` authorises one, and --no-browser
   * makes it drivable from here exactly like `claude auth login`: it prints an
   * authorization URL and then blocks reading the redirect URL back on stdin.
   *
   * This used to be a flat refusal, which is why Gmail and Drive looked
   * impossible to configure on a machine that had never authorised them.
   */
  if (svc.auth.kind === "account") {
    if (body.action === "start-connector-login") return startConnectorLogin(svc.mcpName, svc.label);
    if (body.action === "finish-connector-login") {
      return finishConnectorLogin(String(body.id ?? ""), String(body.redirect ?? ""));
    }
    if (body.action === "cancel-connector-login") {
      dropLogin(String(body.id ?? ""));
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json(
      {
        error:
          `${svc.label} comes from your Claude account. If it isn't listed, enable the ` +
          `connector at claude.ai first; if it is listed, use Authorise.`,
      },
      { status: 400 },
    );
  }

  if (!svc.script) {
    return NextResponse.json(
      { error: `${svc.label} has nothing to set up here.` },
      { status: 400 },
    );
  }

  const script = path.join(process.cwd(), svc.script);

  if (body.action === "register") {
    const missing = (svc.requiredEnv ?? []).filter((k) => !process.env[k]);
    if (missing.length) {
      return NextResponse.json(
        { error: `Set ${missing.join(" and ")} in the shell running this app, then restart it.` },
        { status: 400 },
      );
    }
    const envArgs = (svc.requiredEnv ?? []).flatMap((k) => ["-e", `${k}=${process.env[k]}`]);
    const r = await exec(
      "claude",
      ["mcp", "add", svc.mcpName, ...envArgs, "--", "node", script],
      undefined,
      60_000,
    );
    return r.ok
      ? NextResponse.json({ ok: true, message: `${svc.label} registered.` })
      : NextResponse.json({ error: r.err || r.out || "Registration failed." }, { status: 500 });
  }

  if (body.action === "login") {
    if (svc.auth.kind === "token") {
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token) return NextResponse.json({ error: "No token provided." }, { status: 400 });
      const r = await exec("node", [script, "--login"], token, 60_000);
      return r.ok
        ? NextResponse.json({ ok: true, message: r.out || `Signed in to ${svc.label}.` })
        : NextResponse.json({ error: r.err || r.out || "Sign-in failed." }, { status: 400 });
    }

    // OAuth: the server opens a browser and waits for the redirect.
    const r = await exec("node", [script, "--login"]);
    return r.ok
      ? NextResponse.json({ ok: true, message: r.out || `Signed in to ${svc.label}.` })
      : NextResponse.json({ error: r.err || r.out || "Sign-in failed." }, { status: 400 });
  }

  if (body.action === "logout") {
    const r = await exec("node", [script, "--logout"], undefined, 30_000);
    return NextResponse.json({ ok: r.ok, message: r.out || r.err });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
