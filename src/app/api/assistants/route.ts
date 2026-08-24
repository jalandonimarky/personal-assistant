import path from "node:path";
import { NextResponse } from "next/server";
import { mutate, uid } from "@/lib/store";
import { KNOWLEDGE_HOME, slug, seedRoot } from "@/lib/scope";
import type { Assistant } from "@/lib/types";

export async function POST(req: Request) {
  const body = await req.json();
  const name = String(body.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "A name is required." }, { status: 400 });
  }

  // Every assistant gets its own writable directory. Read-only references are
  // opt-in — a new assistant sees nothing but its own knowledge by default.
  const id = uid();
  const knowledgeRoot =
    String(body.knowledgeRoot ?? "").trim() ||
    path.join(KNOWLEDGE_HOME, `${slug(name)}-${id.slice(0, 8)}`);

  const readableDirs = Array.isArray(body.readableDirs)
    ? body.readableDirs.map(String).map((d: string) => d.trim()).filter(Boolean)
    : [];

  const assistant: Assistant = {
    id,
    name,
    description: String(body.description ?? "").trim(),
    systemPrompt: String(body.systemPrompt ?? "").trim(),
    knowledgeRoot,
    readableDirs,
    createdAt: Date.now(),
  };

  seedRoot(knowledgeRoot, name);

  mutate((s) => {
    s.assistants.push(assistant);
  });

  return NextResponse.json(assistant);
}
