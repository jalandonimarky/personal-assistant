import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Store, Assistant } from "./types";
import { KNOWLEDGE_HOME, slug, seedRoot } from "./scope";

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

const HOME = os.homedir();

/**
 * Where the assistants may READ by default. Point this at wherever your notes
 * live — it is browsed in the Knowledge tab and passed to the CLI as --add-dir.
 * Change it here before first run, or in data/store.json afterwards.
 */
const NOTES = path.join(HOME, "Notes");

function seedAssistants(): Assistant[] {
  const now = Date.now();
  return [
    {
      id: randomUUID(),
      // Owns its own directory, and additionally READS a reference directory it
      // cannot write to. This is the pattern for "knows my existing notes".
      knowledgeRoot: path.join(KNOWLEDGE_HOME, "research-analyst"),
      readableDirs: [NOTES],
      name: "Research Analyst",
      description:
        "Tracks an ongoing workstream against a reference library it can read but not modify.",
      systemPrompt: [
        "You track an ongoing workstream. The knowledge base lives on disk. Read it",
        "before answering — do not guess at project state. Cite the file you took a",
        "fact from.",
        "",
        "Persist durable structure, re-query volatile state. Store mappings, IDs, and",
        "decisions; never store a snapshot that goes stale (a current sprint name, a",
        "live count) when you could store the query that produces it instead.",
      ].join("\n"),
      createdAt: now,
    },
    {
      id: randomUUID(),
      knowledgeRoot: path.join(KNOWLEDGE_HOME, "project-manager"),
      readableDirs: [],
      name: "Project Manager",
      description:
        "Help track projects, including key deliverables, resourcing, timelines, architectures, decision trees",
      systemPrompt: [
        "You help track projects: deliverables, resourcing, timelines, architectures,",
        "and decision trees.",
        "",
        "Keep a durable picture of each project. When you learn something structural",
        "(an owner, a board ID, a dependency), record it. When you need volatile state",
        "(current status, today's blockers), look it up rather than trusting a stored",
        "value that will go stale.",
      ].join("\n"),
      createdAt: now - 1,
    },
    {
      id: randomUUID(),
      knowledgeRoot: path.join(KNOWLEDGE_HOME, "executive-assistant"),
      readableDirs: [],
      name: "Executive Assistant",
      description:
        "You are my executive assistant, helping me track the people and commitments around my work.",
      systemPrompt: [
        "You are an executive assistant. You track people, commitments, and follow-ups.",
        "",
        "For every commitment, know: who owns it, what unblocks it, and when it was last",
        "moved. Surface things that have gone quiet. Be concrete about names and dates.",
        "",
        "Write every commitment as a task line, so the Pulse sweep can find it:",
        "",
        "  - [ ] <what> @<owner> moved:<YYYY-MM-DD> blocked:<what unblocks it> due:<YYYY-MM-DD>",
        "",
        "Only the text is required. `moved:` is what makes staleness exact — update it",
        "to today's date every time an item actually moves, and never otherwise. Tick",
        "the box (`- [x]`) when it's done rather than deleting the line.",
        "See README.md in your knowledge directory for the full convention.",
      ].join("\n"),
      createdAt: now - 2,
    },
  ];
}

function defaults(): Store {
  return {
    assistants: seedAssistants(),
    threads: [],
    messages: [],
    questions: [],
    sweeps: [],
    settings: {
      knowledgeDirs: [NOTES],
      knowledgeRoot: NOTES,
    },
  };
}

/**
 * No in-memory cache, deliberately.
 *
 * Next bundles each route handler separately, so a module-level cache is not
 * shared between them — one route can hold a stale snapshot and clobber another
 * route's write. Every read hits disk and every mutation is read-modify-write.
 * The store is a small local JSON file; this costs nothing and cannot go stale.
 */

/**
 * Older stores had no per-assistant knowledge scoping — every assistant fell back
 * to the shared root, which made the real kb writable by all of them. Give any
 * assistant missing a root its own, and downgrade the old shared root to a
 * read-only reference.
 */
function migrate(s: Store): boolean {
  let changed = false;

  // Stores written before the Pulse tab existed have no sweep log.
  if (!Array.isArray(s.sweeps)) {
    s.sweeps = [];
    changed = true;
  }

  for (const a of s.assistants) {
    if (!a.knowledgeRoot) {
      a.knowledgeRoot = path.join(KNOWLEDGE_HOME, slug(a.name));
      a.readableDirs ??= [s.settings.knowledgeRoot];
      changed = true;
    }
    seedRoot(a.knowledgeRoot, a.name);
  }
  return changed;
}

export function read(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as Store;
    if (migrate(parsed)) write(parsed);
    return parsed;
  } catch {
    const fresh = defaults();
    migrate(fresh);
    write(fresh);
    return fresh;
  }
}

export function write(next: Store): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Atomic rename so a crash mid-save can't truncate the store.
  const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

/** Read-modify-write against disk, so concurrent routes can't clobber. */
export function mutate(fn: (s: Store) => void): Store {
  const s = read();
  fn(s);
  write(s);
  return s;
}

export const uid = () => randomUUID();
