import { NextResponse } from "next/server";
import { mutate } from "@/lib/store";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json();

  mutate((s) => {
    const a = s.assistants.find((x) => x.id === id);
    if (!a) return;
    if (typeof body.name === "string") a.name = body.name.trim() || a.name;
    if (typeof body.description === "string") a.description = body.description;
    if (typeof body.systemPrompt === "string") a.systemPrompt = body.systemPrompt;
    if (typeof body.voice === "string") a.voice = body.voice;
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  mutate((s) => {
    const threadIds = new Set(
      s.threads.filter((t) => t.assistantId === id).map((t) => t.id),
    );
    s.assistants = s.assistants.filter((a) => a.id !== id);
    s.threads = s.threads.filter((t) => t.assistantId !== id);
    s.messages = s.messages.filter((m) => !threadIds.has(m.threadId));
    s.questions = s.questions.filter((q) => q.assistantId !== id);
  });

  return NextResponse.json({ ok: true });
}
