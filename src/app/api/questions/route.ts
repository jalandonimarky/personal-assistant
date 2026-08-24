import { NextResponse } from "next/server";
import { mutate } from "@/lib/store";

export async function PATCH(req: Request) {
  const body = await req.json();
  const id = String(body.id ?? "");
  const answered = Boolean(body.answered);

  mutate((s) => {
    const q = s.questions.find((x) => x.id === id);
    if (q) q.answered = answered;
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  mutate((s) => {
    s.questions = s.questions.filter((q) => q.id !== id);
  });

  return NextResponse.json({ ok: true });
}
