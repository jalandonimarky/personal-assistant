import { NextResponse } from "next/server";
import path from "node:path";
import { spawn } from "node:child_process";
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

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const svc = typeof body.id === "string" ? getService(body.id) : null;
  if (!svc) return NextResponse.json({ error: "Unknown service." }, { status: 400 });
  if (!svc.script || svc.auth.kind === "account") {
    return NextResponse.json(
      { error: `${svc.label} is managed by your Claude account — nothing to set up here.` },
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
