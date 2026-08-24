import { NextResponse } from "next/server";
import { mutate, uid } from "@/lib/store";
import type { Thread } from "@/lib/types";

export async function POST(req: Request) {
  const body = await req.json();
  const assistantId = String(body.assistantId ?? "");
  if (!assistantId) {
    return NextResponse.json({ error: "assistantId required" }, { status: 400 });
  }

  const now = Date.now();
  const thread: Thread = {
    id: uid(),
    assistantId,
    title: "New discussion",
    sessionId: null,
    createdAt: now,
    updatedAt: now,
  };

  mutate((s) => {
    s.threads.push(thread);
  });

  return NextResponse.json(thread);
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  mutate((s) => {
    s.threads = s.threads.filter((t) => t.id !== id);
    s.messages = s.messages.filter((m) => m.threadId !== id);
    s.questions = s.questions.filter((q) => q.threadId !== id);
  });

  return NextResponse.json({ ok: true });
}
