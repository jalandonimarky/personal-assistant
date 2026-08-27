import { NextResponse } from "next/server";
import { read, mutate, uid } from "@/lib/store";
import { getMode } from "@/lib/modes";
import { runClaude } from "@/lib/claude";
import { readableFor, neutralCwd } from "@/lib/scope";
import type { Message, Question } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 1200;

/**
 * Answer a parked question and re-run the turn it came from.
 *
 * The answer is sent back into the *originating* discussion, so the assistant
 * revises its own earlier reply with the ambiguity resolved — rather than the
 * user having to restate the whole request somewhere else.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const questionId = String(body.questionId ?? "");
  const answer = String(body.answer ?? "").trim();
  const mode = getMode(String(body.mode ?? "brainstorming"));

  if (!questionId || !answer) {
    return NextResponse.json(
      { error: "questionId and answer are required." },
      { status: 400 },
    );
  }

  const state = read();
  const question = state.questions.find((q) => q.id === questionId);
  if (!question) {
    return NextResponse.json({ error: "Unknown question." }, { status: 404 });
  }

  const thread = state.threads.find((t) => t.id === question.threadId);
  const assistant = state.assistants.find((a) => a.id === question.assistantId);

  // No thread to continue — just record the answer.
  if (!thread || !assistant) {
    mutate((s) => {
      const q = s.questions.find((x) => x.id === questionId)!;
      q.answer = answer;
      q.answered = true;
      q.answeredAt = Date.now();
    });
    return NextResponse.json({ regenerated: false });
  }

  const prompt = [
    `Answering the question you parked earlier: "${question.text}"`,
    "",
    answer,
    "",
    "Revise your previous response in this discussion accordingly. Give the corrected",
    "version in full — don't just describe what changed.",
  ].join("\n");

  const userMessage: Message = {
    id: uid(),
    threadId: thread.id,
    role: "user",
    content: `↩︎ Answered: “${question.text}”\n\n${answer}`,
    mode: mode.id,
    costUsd: null,
    createdAt: Date.now(),
  };

  mutate((s) => {
    s.messages.push(userMessage);
    const q = s.questions.find((x) => x.id === questionId)!;
    q.answer = answer;
    q.answered = true;
    q.answeredAt = Date.now();
  });

  try {
    const result = await runClaude({
      prompt,
      systemPrompt: assistant.systemPrompt || assistant.description,
      mode,
      sessionId: thread.sessionId,
      newSessionId: uid(),
      addDirs: readableFor(assistant, state.settings),
      // Outside the user's workspace, so Claude Code does not pull their
      // project memory into this assistant's context. See scope.ts.
      cwd: neutralCwd(),
    });

    const reply: Message = {
      id: uid(),
      threadId: thread.id,
      role: "assistant",
      content: result.text,
      mode: mode.id,
      costUsd: result.costUsd,
      createdAt: Date.now(),
    };

    const follow: Question[] = result.questions.map((text) => ({
      id: uid(),
      assistantId: assistant.id,
      threadId: thread.id,
      text,
      answered: false,
      createdAt: Date.now(),
    }));

    mutate((s) => {
      s.messages.push(reply);
      s.questions.push(...follow);
      const t = s.threads.find((x) => x.id === thread.id)!;
      t.sessionId = result.sessionId;
      t.updatedAt = Date.now();
    });

    return NextResponse.json({ regenerated: true, threadId: thread.id });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    mutate((s) => {
      s.messages.push({
        id: uid(),
        threadId: thread.id,
        role: "assistant",
        content: `⚠️ ${detail}`,
        mode: mode.id,
        costUsd: null,
        createdAt: Date.now(),
      });
    });
    return NextResponse.json({ regenerated: false, threadId: thread.id });
  }
}
