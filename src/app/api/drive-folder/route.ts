import { NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { read, mutate } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Google Drive without any credential at all.
 *
 * Drive for Desktop mounts the whole Drive as a folder, and this app already
 * hands every readable directory to the CLI as --add-dir. So "connect Drive"
 * can be nothing more than "add that folder" — no Cloud project, no OAuth
 * client, no app password, no API.
 *
 * THE ONE REAL LIMITATION, worth stating rather than discovering: Google-native
 * Docs, Sheets and Slides sync as .gdoc/.gsheet stubs holding a document id,
 * not the document. Those are unreadable this way. Anything stored as .docx,
 * .xlsx, .pdf and so on reads perfectly, and the app already extracts text from
 * those on upload.
 */

/** Where Drive for Desktop mounts, across the versions people actually have. */
function candidates(): string[] {
  const home = os.homedir();
  const found: string[] = [];

  const cloud = path.join(home, "Library", "CloudStorage");
  try {
    for (const entry of fs.readdirSync(cloud)) {
      if (/^GoogleDrive-/.test(entry)) found.push(path.join(cloud, entry));
    }
  } catch {
    /* no CloudStorage directory — older macOS, or Drive not installed */
  }

  // Pre-CloudStorage layouts.
  for (const legacy of ["Google Drive", "GoogleDrive"]) {
    const p = path.join(home, legacy);
    try {
      if (fs.statSync(p).isDirectory()) found.push(p);
    } catch {
      /* not there */
    }
  }
  return found;
}

export async function GET() {
  const state = read();
  const dirs = state.settings.knowledgeDirs ?? [];
  const detected = candidates().map((p) => ({
    path: p,
    added: dirs.some((d) => d === p || p.startsWith(`${d}${path.sep}`)),
  }));

  return NextResponse.json({
    installed: detected.length > 0,
    detected,
    knowledgeDirs: dirs,
    hint:
      detected.length > 0
        ? null
        : "Install Google Drive for Desktop and sign in with your Google account. No API access is involved.",
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const dir = typeof body.path === "string" ? body.path : "";
  const remove = body.action === "remove";

  // Only ever a directory that actually exists, and for adds only one this
  // route detected — a client-supplied path must not widen what the model can
  // read just by being posted here.
  if (!dir) return NextResponse.json({ error: "No path given." }, { status: 400 });
  if (!remove && !candidates().includes(dir)) {
    return NextResponse.json(
      { error: "That is not a detected Drive folder." },
      { status: 400 },
    );
  }

  const next = mutate((s) => {
    const dirs = new Set(s.settings.knowledgeDirs ?? []);
    if (remove) dirs.delete(dir);
    else dirs.add(dir);
    s.settings.knowledgeDirs = [...dirs];
  });

  return NextResponse.json({
    ok: true,
    knowledgeDirs: next.settings.knowledgeDirs,
    message: remove ? "Drive folder removed." : "Drive folder added.",
  });
}
