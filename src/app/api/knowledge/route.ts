import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { read } from "@/lib/store";
import { rootFor, readableFor, safeJoin } from "@/lib/scope";

export const dynamic = "force-dynamic";

const SKIP = new Set(["node_modules", ".git", ".next", "data", ".DS_Store"]);

function resolveAssistant(assistantId: string | null) {
  const s = read();
  const a = s.assistants.find((x) => x.id === assistantId);
  if (!a) return null;
  return { assistant: a, settings: s.settings };
}

function walk(dir: string, root: string, depth = 0): string[] {
  if (depth > 4) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, root, depth + 1));
    else if (/\.(md|markdown|txt)$/i.test(e.name))
      out.push(path.relative(root, full));
  }
  return out;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const ctx = resolveAssistant(searchParams.get("assistantId"));
  if (!ctx) {
    return NextResponse.json({ error: "Unknown assistant." }, { status: 404 });
  }

  const root = rootFor(ctx.assistant, ctx.settings);
  const file = searchParams.get("file");

  if (!file) {
    return NextResponse.json({
      root,
      files: walk(root, root).sort(),
      // Read-only references, shown so it's obvious what else it can see.
      readable: readableFor(ctx.assistant, ctx.settings).filter((d) => d !== root),
    });
  }

  const target = safeJoin(root, file);
  if (!target) {
    return NextResponse.json({ error: "Path outside root." }, { status: 400 });
  }
  try {
    return NextResponse.json({ file, content: fs.readFileSync(target, "utf8") });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not read file." },
      { status: 404 },
    );
  }
}

export async function PUT(req: Request) {
  const body = await req.json();
  const ctx = resolveAssistant(String(body.assistantId ?? ""));
  if (!ctx) {
    return NextResponse.json({ error: "Unknown assistant." }, { status: 404 });
  }

  const root = rootFor(ctx.assistant, ctx.settings);
  const target = safeJoin(root, String(body.file ?? ""));
  if (!target) {
    return NextResponse.json(
      { error: "Refused — that path is outside this assistant's directory." },
      { status: 400 },
    );
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, String(body.content ?? ""), "utf8");
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const ctx = resolveAssistant(searchParams.get("assistantId"));
  if (!ctx) {
    return NextResponse.json({ error: "Unknown assistant." }, { status: 404 });
  }

  const root = rootFor(ctx.assistant, ctx.settings);
  const target = safeJoin(root, searchParams.get("file") ?? "");
  if (!target) {
    return NextResponse.json(
      { error: "Refused — that path is outside this assistant's directory." },
      { status: 400 },
    );
  }
  try {
    fs.unlinkSync(target);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not delete." },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
