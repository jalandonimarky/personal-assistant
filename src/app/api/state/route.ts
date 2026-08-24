import { NextResponse } from "next/server";
import { read } from "@/lib/store";
import { MODES } from "@/lib/modes";
import { rootFor } from "@/lib/scope";
import { scanRoot } from "@/lib/staleness";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = read();

  /**
   * Bucket counts per assistant, so the Pulse tab can carry a badge and nag
   * without being opened. Re-derived from disk every load rather than stored —
   * a count of what is stale goes wrong within a day. Cheap because these are
   * small local markdown trees; if a knowledge root ever grows large, this is
   * the first thing to move behind a cache.
   */
  const pulse: Record<string, ReturnType<typeof scanRoot>["counts"]> = {};
  for (const a of s.assistants) {
    try {
      pulse[a.id] = scanRoot(rootFor(a, s.settings)).counts;
    } catch {
      // A missing or unreadable root shouldn't take the whole page down.
    }
  }

  return NextResponse.json({
    assistants: s.assistants,
    threads: s.threads,
    messages: s.messages,
    questions: s.questions,
    settings: s.settings,
    pulse,
    modes: MODES.map(({ id, label, blurb, model }) => ({
      id,
      label,
      blurb,
      model,
    })),
  });
}
