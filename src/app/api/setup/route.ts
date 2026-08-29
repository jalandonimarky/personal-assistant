import { NextResponse } from "next/server";
import path from "node:path";
import { spawn } from "node:child_process";

export const dynamic = "force-dynamic";
// Must be a literal — an expression here fails the build.
// A global npm install pulls a lot down on a slow connection.
export const maxDuration = 600;

/**
 * The setup steps that otherwise need a terminal.
 *
 * Installing Claude Code and wiring the launchd agents are both one-line
 * commands, and both were the only reason a second machine had to drop to a
 * shell after the app was already running. There is no reason a local tool
 * cannot run its own installer.
 *
 * EVERY COMMAND HERE IS A FIXED LITERAL. Nothing from the request reaches an
 * argument list — the action name selects from a closed set and that is all.
 * This route can install a known package and run a script that ships with the
 * repo; it cannot be persuaded to run something else.
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
  timeout = 590_000,
): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd: process.cwd() });
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
  });
}

const AGENTS = path.join(process.cwd(), "scripts/install-agents.sh");

/** Last line of output is usually the useful one; npm is verbose. */
const lastLine = (s: string) =>
  s.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "install-cli") {
    const r = await exec("npm", ["install", "-g", "@anthropic-ai/claude-code"]);
    if (r.ok) {
      return NextResponse.json({
        ok: true,
        message: "Claude Code installed. Press Re-check.",
      });
    }
    // The usual failure is a global prefix the user cannot write to. Say that
    // rather than returning npm's wall of text.
    const permission = /EACCES|permission denied/i.test(r.err);
    return NextResponse.json(
      {
        error: permission
          ? "npm could not write to its global folder. Run this once in a terminal: sudo npm install -g @anthropic-ai/claude-code"
          : lastLine(r.err) || lastLine(r.out) || "Install failed.",
      },
      { status: 500 },
    );
  }

  if (action === "agents-status") {
    const r = await exec("bash", [AGENTS, "--status"], 60_000);
    return NextResponse.json({ ok: r.ok, out: r.out || r.err });
  }

  if (action === "agents-install") {
    const r = await exec("bash", [AGENTS], 120_000);
    return r.ok
      ? NextResponse.json({
          ok: true,
          message: "Background services installed — the app, the Telegram relay and the 08:00 sweep.",
        })
      : NextResponse.json({ error: lastLine(r.err) || "Could not install." }, { status: 500 });
  }

  if (action === "agents-uninstall") {
    const r = await exec("bash", [AGENTS, "--uninstall"], 120_000);
    return r.ok
      ? NextResponse.json({ ok: true, message: "Background services removed." })
      : NextResponse.json({ error: lastLine(r.err) || "Could not remove." }, { status: 500 });
  }

  /**
   * What optional tooling is present, so the panel can stop guessing.
   *
   * The python check PROBES interpreters rather than trusting whichever one
   * PATH offers. That distinction has now caught this project out four times:
   * a Homebrew or pyenv python3 is routinely first on PATH while having
   * neither openpyxl nor python-pptx, so a plain `python3 -c "import openpyxl"`
   * reports the tooling missing on a machine where it is installed and working.
   */
  if (action === "tooling") {
    const candidates = [
      "/usr/local/bin/python3",
      "python3",
      "/opt/homebrew/bin/python3",
      "/usr/bin/python3",
    ];
    let pythonDocs = false;
    for (const bin of candidates) {
      const r = await exec(bin, ["-c", "import openpyxl, pptx"], 30_000);
      if (r.ok) {
        pythonDocs = true;
        break;
      }
    }
    const soffice = await exec("soffice", ["--version"], 60_000);
    return NextResponse.json({ libreoffice: soffice.ok, pythonDocs });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
