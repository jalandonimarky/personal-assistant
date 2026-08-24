import { NextResponse } from "next/server";
import { read, mutate, uid } from "@/lib/store";
import { PULSE_MODE } from "@/lib/modes";
import { runClaude } from "@/lib/claude";
import { readableFor, rootFor } from "@/lib/scope";
import { scanRoot, renderScan, AGING_AFTER, STALE_AFTER, COLD_AFTER } from "@/lib/staleness";
import type { Question, Sweep } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 1200;

/** How many sweeps to keep per assistant before dropping the oldest. */
const KEEP_SWEEPS = 20;

function resolve(assistantId: string) {
  const state = read();
  const assistant = state.assistants.find((a) => a.id === assistantId);
  return assistant ? { state, assistant } : null;
}

const THRESHOLDS = { agingAfter: AGING_AFTER, staleAfter: STALE_AFTER, coldAfter: COLD_AFTER };

/**
 * GET — the deterministic scan. No model, no cost, safe to call on every tab
 * open. This is the source of truth for what is stale.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const ctx = resolve(searchParams.get("assistantId") ?? "");
  if (!ctx) {
    return NextResponse.json({ error: "Unknown assistant." }, { status: 404 });
  }

  const root = rootFor(ctx.assistant, ctx.state.settings);
  const latest = ctx.state.sweeps
    .filter((s) => s.assistantId === ctx.assistant.id)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  return NextResponse.json({
    scan: scanRoot(root),
    thresholds: THRESHOLDS,
    latest: latest ?? null,
  });
}

/**
 * POST — run a sweep: scan, then hand the scan to the model for prioritisation.
 *
 * Each sweep starts a fresh CLI session rather than resuming. A sweep is a
 * standalone report; resuming would drag every previous sweep's context along
 * and make each one slower and more confused than the last.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const ctx = resolve(String(body.assistantId ?? ""));
  if (!ctx) {
    return NextResponse.json({ error: "Unknown assistant." }, { status: 404 });
  }

  const { state, assistant } = ctx;
  const root = rootFor(assistant, state.settings);
  const scan = scanRoot(root);

  // A skipped sweep must not clear the digest already on screen, so these carry
  // the previous sweep through rather than returning null.
  const previous =
    state.sweeps
      .filter((s) => s.assistantId === assistant.id)
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;

  if (scan.open.length === 0) {
    return NextResponse.json({
      scan,
      thresholds: THRESHOLDS,
      latest: previous,
      skipped: "Nothing to sweep — no open commitments found.",
    });
  }

  /**
   * Scheduled runs pass onlyIfStale so a daily sweep doesn't burn a model call
   * to report that everything is fine. Pressing the button in the UI does not —
   * asking for a sweep should always get an answer.
   */
  const quiet = scan.counts.cold + scan.counts.stale + scan.counts.overdue;
  if (body.onlyIfStale && quiet === 0) {
    return NextResponse.json({
      scan,
      thresholds: THRESHOLDS,
      latest: previous,
      skipped: `Nothing has gone quiet — ${scan.counts.open} open, none past ${STALE_AFTER} days.`,
    });
  }

  const prompt = [
    `Staleness scan of ${root}, run ${new Date(scan.scannedAt).toDateString()}.`,
    "",
    `Thresholds: aging at ${AGING_AFTER}d, stale at ${STALE_AFTER}d, cold at ${COLD_AFTER}d since last movement.`,
    `${scan.counts.open} open · ${scan.counts.overdue} overdue · ${scan.counts.cold} cold · ${scan.counts.stale} stale · ${scan.counts.aging} aging`,
    "",
    renderScan(scan),
    ...(scan.uncovered.length
      ? ["", `Markdown files holding no commitments: ${scan.uncovered.join(", ")}`]
      : []),
  ].join("\n");

  try {
    const result = await runClaude({
      prompt,
      systemPrompt: assistant.systemPrompt || assistant.description,
      mode: PULSE_MODE,
      sessionId: null,
      newSessionId: uid(),
      addDirs: readableFor(assistant, state.settings),
      cwd: root,
    });

    const sweep: Sweep = {
      id: uid(),
      assistantId: assistant.id,
      createdAt: Date.now(),
      digest: result.text,
      counts: scan.counts,
      costUsd: result.costUsd,
    };

    // A sweep can park questions like any other turn — "is that item still
    // live?" belongs in the Questions tab, not buried in a digest.
    const questions: Question[] = result.questions.map((text) => ({
      id: uid(),
      assistantId: assistant.id,
      threadId: null,
      text,
      answered: false,
      createdAt: Date.now(),
    }));

    mutate((s) => {
      s.sweeps.push(sweep);
      s.questions.push(...questions);
      const mine = s.sweeps
        .filter((x) => x.assistantId === assistant.id)
        .sort((a, b) => b.createdAt - a.createdAt);
      const drop = new Set(mine.slice(KEEP_SWEEPS).map((x) => x.id));
      if (drop.size) s.sweeps = s.sweeps.filter((x) => !drop.has(x.id));
    });

    return NextResponse.json({ scan, thresholds: THRESHOLDS, latest: sweep, questions });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { scan, thresholds: THRESHOLDS, latest: previous, error: detail },
      { status: 200 },
    );
  }
}
