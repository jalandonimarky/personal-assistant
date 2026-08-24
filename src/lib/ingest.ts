/**
 * Ingest types — how a pasted source becomes a knowledge file.
 *
 * Each type answers three separable questions that the original single
 * "paste a meeting" template answered all at once:
 *
 *   1. Routing — which subdirectory, what filename
 *   2. Shape   — which sections
 *   3. Pulse   — does this kind of source legitimately produce commitments?
 *
 * (3) is the one that matters. Telling the model to "turn every commitment
 * into a task line" and then handing it a deck produces commitments nobody
 * made — and the staleness scanner, being deterministic, lends them false
 * authority. So a reference is told explicitly not to emit task lines.
 *
 * Add or rename freely; the UI renders whatever is in INGEST_TYPES.
 */

export type IngestId = "auto" | "meeting" | "thread" | "document" | "decision";

export interface IngestType {
  id: IngestId;
  label: string;
  /** What this kind of paste is, in the model's words. */
  what: string;
  /** Path under the assistant's own knowledge root. `{date}` is substituted. */
  file: string;
  /** Section structure, already prose-joined for the prompt. */
  structure: string;
  /** Whether this source can legitimately produce Pulse task lines. */
  commitments: boolean;
}

/** Everything except `auto`, which is a router rather than a destination. */
export const INGEST_TYPES: IngestType[] = [
  {
    id: "meeting",
    label: "Meeting",
    what: "a meeting — attendees, discussion, things landed on",
    file: "meetings/{date}-<slug>.md",
    structure: "Decisions · Actions (with owner) · Open questions · Risks",
    commitments: true,
  },
  {
    id: "thread",
    label: "Slack / email thread",
    what: "a Slack or email thread — a back-and-forth between people",
    file: "threads/{date}-<slug>.md",
    structure: "What was asked · What was agreed · Who owns what · Still open",
    commitments: true,
  },
  {
    id: "document",
    label: "Document or deck",
    what: "a document, deck, report, or export — a source someone else authored",
    // Undated: re-ingesting the same document should update it, not fork it.
    file: "references/<slug>.md",
    structure:
      "What it claims · Figures, each with the source locator it came from " +
      "(slide, tab, page) · What could not be sourced",
    commitments: false,
  },
  {
    id: "decision",
    label: "Decision",
    what: "a decision — one call, and the reasoning behind it",
    file: "decisions/{date}-<slug>.md",
    structure:
      "Context · Options considered · What was chosen · Why · What would change it",
    commitments: false,
  },
];

export const getIngest = (id: string): IngestType | null =>
  INGEST_TYPES.find((t) => t.id === id) ?? null;

/** Options for the picker, router first. */
export const INGEST_OPTIONS: { id: IngestId; label: string }[] = [
  { id: "auto", label: "Auto-detect" },
  ...INGEST_TYPES.map((t) => ({ id: t.id, label: t.label })),
];

const taskLine = (date: string) =>
  `- [ ] <what> @<owner> moved:${date} due:<date>`;

const REFLECT = [
  "Open your reply by naming where you filed it and why — one line.",
  "",
  "Then tell me what's new, what contradicts what you already knew, and what's",
  "now stale.",
].join("\n");

/**
 * The instruction prefilled into the composer. Visible and editable on purpose:
 * the user can see exactly what the assistant was told before sending.
 *
 * `date` is passed in rather than computed here so a tab left open overnight
 * can't stamp yesterday into the filing instruction.
 */
export function ingestPrompt(id: IngestId, date: string): string {
  const t = getIngest(id);

  if (!t) {
    // Auto-detect: the model picks the bucket, never the format. The whole
    // table goes in so its classification and its structure stay consistent
    // with an explicitly-chosen type.
    const rows = INGEST_TYPES.map(
      (x) =>
        `| ${x.what} | \`${x.file.replace("{date}", date)}\` | ${x.structure} | ${
          x.commitments ? "yes" : "**no — never**"
        } |`,
    ).join("\n");

    return [
      "Work out what this is, then file it into YOUR OWN knowledge directory",
      "using the matching convention below. Do not write anywhere else.",
      "",
      "| If it is | File it as | Structure | Task lines |",
      "|---|---|---|---|",
      rows,
      "",
      "If it is none of these, choose a sensible directory and structure, and say",
      "what you chose. Follow the convention as written — do not invent your own",
      "headings or reword the task-line syntax.",
      "",
      "Task lines, only where the table allows them, and only for commitments",
      "actually made in the source. Never manufacture one:",
      "",
      taskLine(date),
      "",
      "Drop the chatter.",
      "",
      "Open your reply by naming what you classified this as, where you filed it,",
      "and why. If it is genuinely a toss-up between two, file it under your best",
      "reading and park the question rather than stopping.",
      "",
      "Then tell me what's new, what contradicts what you already knew, and what's",
      "now stale.",
      "",
      "---",
      "",
      "",
    ].join("\n");
  }

  return [
    `File this into YOUR OWN knowledge directory as ${t.file.replace("{date}", date)}.`,
    "Do not write anywhere else.",
    "",
    `This is ${t.what}.`,
    "",
    `Structure it: ${t.structure}. Drop the chatter.`,
    "",
    ...(t.commitments
      ? [
          "Turn every commitment into a task line so Pulse tracks it. Only",
          "commitments actually made in the source — never manufacture one:",
          "",
          taskLine(date),
        ]
      : [
          "Do NOT write task lines (`- [ ]`) in this file. This kind of source",
          "records what is true, not what anyone committed to, and Pulse would",
          "treat invented items as real commitments.",
        ]),
    "",
    REFLECT,
    "",
    "---",
    "",
    "",
  ].join("\n");
}
