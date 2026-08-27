import { NextResponse } from "next/server";
import { read, mutate, uid } from "@/lib/store";
import { getMode } from "@/lib/modes";
import { runClaude } from "@/lib/claude";
import { readableFor, neutralCwd } from "@/lib/scope";
import { toolsFor } from "@/lib/services";
import type { Message, Question } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 1200;

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t || "New discussion";
}

export async function POST(req: Request) {
  const body = await req.json();
  const threadId = String(body.threadId ?? "");
  const content = String(body.content ?? "").trim();
  const mode = getMode(String(body.mode ?? "brainstorming"));

  if (!threadId || !content) {
    return NextResponse.json(
      { error: "threadId and content are required." },
      { status: 400 },
    );
  }

  const state = read();
  const thread = state.threads.find((t) => t.id === threadId);
  if (!thread) {
    return NextResponse.json({ error: "Unknown thread." }, { status: 404 });
  }
  const assistant = state.assistants.find((a) => a.id === thread.assistantId);
  if (!assistant) {
    return NextResponse.json({ error: "Unknown assistant." }, { status: 404 });
  }

  const now = Date.now();
  const userMessage: Message = {
    id: uid(),
    threadId,
    role: "user",
    content,
    mode: mode.id,
    costUsd: null,
    createdAt: now,
  };

  const isFirstTurn = !thread.sessionId;
  mutate((s) => {
    s.messages.push(userMessage);
    const t = s.threads.find((x) => x.id === threadId)!;
    if (isFirstTurn) t.title = titleFrom(content);
    t.updatedAt = now;
  });

  const newSessionId = uid();

  try {
    const result = await runClaude({
      prompt: content,
      systemPrompt: assistant.systemPrompt || assistant.description,
      voice: assistant.voice,
      mode,
      sessionId: thread.sessionId,
      newSessionId,
      addDirs: readableFor(assistant, state.settings),
      // Outside the user's workspace, so Claude Code does not pull their
      // project memory into this assistant's context. See scope.ts.
      cwd: neutralCwd(),
      // Granted for this turn only. toolsFor() drops anything not in the
      // registry, so client-supplied ids never reach --allowedTools verbatim.
      // The second argument is the mode gate: only a mode that already carries
      // Write may unlock a service's write tools, so a write grant sent to
      // Brainstorming degrades to read rather than elevating it.
      serviceTools: toolsFor(body.services, mode.tools.includes("Write")),
      channel: body.channel === "plain" ? "plain" : "web",
    });

    const reply: Message = {
      id: uid(),
      threadId,
      role: "assistant",
      content: result.text,
      mode: mode.id,
      costUsd: result.costUsd,
      createdAt: Date.now(),
    };

    const questions: Question[] = result.questions.map((text) => ({
      id: uid(),
      assistantId: assistant.id,
      threadId,
      text,
      answered: false,
      createdAt: Date.now(),
    }));

    mutate((s) => {
      s.messages.push(reply);
      s.questions.push(...questions);
      const t = s.threads.find((x) => x.id === threadId)!;
      t.sessionId = result.sessionId;
      t.updatedAt = Date.now();
    });

    return NextResponse.json({ message: reply, questions });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const failure: Message = {
      id: uid(),
      threadId,
      role: "assistant",
      content: `⚠️ ${detail}`,
      mode: mode.id,
      costUsd: null,
      createdAt: Date.now(),
    };
    mutate((s) => {
      s.messages.push(failure);
    });
    return NextResponse.json({ message: failure, questions: [] }, { status: 200 });
  }
}
