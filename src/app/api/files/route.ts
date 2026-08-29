import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { read } from "@/lib/store";
import { inboxDir, outboxDir, readableFor } from "@/lib/scope";

export const dynamic = "force-dynamic";

/**
 * Acting on a file the assistant produced.
 *
 * A reply that says "saved to /Users/…/report.xlsx" is a dead end: the path is
 * correct and completely useless, because the one thing you want to do with a
 * deliverable — look at it — needs a Finder window you now have to go and open
 * yourself. This makes the path clickable.
 *
 * Three verbs, because they answer different questions: `open` launches the
 * file in whatever app owns it, `reveal` shows it in Finder (what you want when
 * there are several files, or you mean to move it), and `download` streams the
 * bytes for the browser to save.
 *
 * SCOPE IS ENFORCED, NOT ASSUMED. The path arrives from the page, which got it
 * from model output — so it is untrusted twice over. Every path is resolved and
 * must sit inside a directory this app already exposes: the outbox, the inbox,
 * or a readable knowledge directory. Anything else is refused, which stops a
 * crafted path from turning "open my spreadsheet" into "open ~/.ssh/id_rsa".
 */

function allowedRoots(): string[] {
  const state = read();
  const roots = new Set<string>([outboxDir(), inboxDir()]);
  for (const a of state.assistants) {
    for (const d of readableFor(a, state.settings)) roots.add(d);
  }
  return [...roots].map((r) => path.resolve(r));
}

/** Resolved path if it is inside an allowed root and really exists. */
function admit(candidate: string): string | null {
  let resolved: string;
  try {
    // realpath collapses symlinks, so a link out of an allowed root is caught.
    resolved = fs.realpathSync(path.resolve(candidate));
  } catch {
    return null;
  }
  const ok = allowedRoots().some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
  if (!ok) return null;

  try {
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

/** GET /api/files?download=<path> — stream one file to the browser. */
export async function GET(req: Request) {
  const target = new URL(req.url).searchParams.get("download");
  if (!target) return NextResponse.json({ error: "No file given." }, { status: 400 });

  const file = admit(target);
  if (!file) {
    return NextResponse.json(
      { error: "That file is not available." },
      { status: 403 },
    );
  }

  const body = fs.readFileSync(file);
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "content-type": "application/octet-stream",
      // Quoted, and quotes stripped from the name, so a filename cannot break
      // out of the header.
      "content-disposition": `attachment; filename="${path.basename(file).replace(/"/g, "")}"`,
      "content-length": String(body.length),
    },
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action : "";

  /**
   * Which of these paths are real and in scope? The page sends every path-like
   * string it found in a message and renders buttons only for what comes back,
   * so a path the model merely mentioned does not get a dead button.
   */
  if (action === "check") {
    const paths: string[] = Array.isArray(body.paths) ? body.paths.slice(0, 50) : [];
    const files = paths
      .filter((p): p is string => typeof p === "string")
      .map((p) => ({ given: p, resolved: admit(p) }))
      .filter((x) => x.resolved)
      .map((x) => {
        const stat = fs.statSync(x.resolved!);
        return {
          path: x.given,
          name: path.basename(x.resolved!),
          bytes: stat.size,
        };
      });
    // Same file mentioned twice in one reply should yield one button.
    const seen = new Set<string>();
    return NextResponse.json({
      files: files.filter((f) => !seen.has(f.path) && seen.add(f.path)),
    });
  }

  if (action === "open" || action === "reveal") {
    const file = admit(typeof body.path === "string" ? body.path : "");
    if (!file) {
      return NextResponse.json({ error: "That file is not available." }, { status: 403 });
    }
    // -R reveals in Finder rather than launching the file.
    const args = action === "reveal" ? ["-R", file] : [file];
    spawn("open", args, { stdio: "ignore", detached: true }).unref();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
