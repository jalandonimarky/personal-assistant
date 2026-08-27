import type { ModeId } from "./types";

export interface Mode {
  id: ModeId;
  label: string;
  blurb: string;
  /** Alias passed to `claude --model`. */
  model: string;
  /** Whitelisted via `claude --allowedTools`. Read-only modes cannot write. */
  tools: string[];
  /** Appended to the assistant's own system prompt. */
  instruction: string;
}

const READ_ONLY = ["Read", "Glob", "Grep"];

/**
 * Producing a deliverable is part of what Authoring IS, not an integration with
 * an outside service — so these are native to the mode rather than something to
 * switch on. They are absent from every read-only mode, which is the same line
 * Write and Edit sit on.
 *
 * Served by mcp/documents. If that server is not registered the names simply do
 * not resolve and the model reports it, exactly like any other missing tool.
 */
const DOCUMENT_TOOLS = [
  "mcp__documents__doc_read",
  "mcp__documents__doc_list",
  "mcp__documents__doc_create_spreadsheet",
  "mcp__documents__doc_create_presentation",
  "mcp__documents__doc_create_document",
];

const READ_WRITE = ["Read", "Glob", "Grep", "Write", "Edit", ...DOCUMENT_TOOLS];

export const MODES: Mode[] = [
  {
    id: "brainstorming",
    label: "Brainstorming",
    blurb: "Discuss ideas, issues, and options",
    model: "sonnet",
    tools: READ_ONLY,
    instruction: [
      "MODE: Brainstorming. Explore the problem with the user. Surface options and",
      "trade-offs, give a recommendation rather than an exhaustive survey, and think",
      "out loud about what is uncertain. Do not write files in this mode.",
    ].join("\n"),
  },
  {
    id: "authoring",
    label: "Authoring",
    blurb: "Write, revise, and persist deliverables",
    model: "opus",
    tools: READ_WRITE,
    instruction: [
      "MODE: Authoring. Produce and persist the deliverable. You may write and edit",
      "files.",
      "",
      "You can also produce real documents — spreadsheets (.xlsx), presentations",
      "(.pptx) and documents (.docx) — and read existing ones to work from. Use",
      "them when the deliverable is genuinely a document; a table in markdown is",
      "still the right answer for a table in a reply.",
      "",
      "When persisting knowledge, store durable structure and re-query volatile state.",
      "Record mappings, IDs, owners, and decisions. Never write down a value that goes",
      "stale within days when you could instead record how to look it up.",
    ].join("\n"),
  },
  {
    id: "critique",
    label: "Critique",
    blurb: "Adversarially review the current thinking",
    // Deliberately a different model from Brainstorming: running the critic on the
    // same model as the generator produces agreement, not challenge.
    model: "opus",
    tools: READ_ONLY,
    instruction: [
      "MODE: Critique. Argue against the current thinking. Find the assumption that",
      "hasn't been checked, the case that breaks it, and the thing that will look",
      "obvious in hindsight.",
      "",
      "Do not hedge and do not restate the plan approvingly. If it genuinely holds up,",
      "say so in one line and name the single weakest point anyway. Do not write files.",
    ].join("\n"),
  },
];

export const getMode = (id: string): Mode =>
  MODES.find((m) => m.id === id) ?? MODES[0];

/**
 * Not in MODES — this one is never user-selectable, it's what /api/pulse runs.
 *
 * Read-only on purpose: a sweep reports, it does not quietly edit the
 * commitments it is reporting on. Staleness itself is already computed
 * deterministically by scanRoot(), so this turn only prioritises and narrates.
 */
export const PULSE_MODE: Mode = {
  id: "pulse",
  label: "Pulse",
  blurb: "Sweep for commitments that have gone quiet",
  model: "opus",
  tools: READ_ONLY,
  instruction: [
    "MODE: Pulse sweep. You are reviewing a staleness scan of the commitments in",
    "this knowledge base.",
    "",
    "The scan is authoritative for dates and day counts. Do not recompute them and",
    "do not contradict them. Open the referenced files when context would change",
    "your judgement about what matters.",
    "",
    "Produce exactly these sections, no preamble:",
    "",
    "**Needs a nudge** — at most 5. For each: the commitment, who owns it, what",
    "unblocks it, and the concrete next action. Order by what actually matters,",
    "not by day count alone — a 40-day item that is waiting on a dead vendor",
    "outranks nothing.",
    "",
    "**Quietly slipping** — one line each, for items drifting but not yet urgent.",
    "",
    "**Coverage** — one line, only if items are dated by file mtime rather than a",
    "`moved:` stamp, or if files hold no commitments at all. Name them so the",
    "convention can be tightened.",
    "",
    "If nothing has gone quiet, say so in one line and stop. Never pad. Be",
    "concrete about names and dates.",
  ].join("\n"),
};
