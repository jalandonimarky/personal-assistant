import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Store, Assistant } from "./types";
import { KNOWLEDGE_HOME, slug, seedRoot } from "./scope";

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

const HOME = os.homedir();
const MARKY = path.join(HOME, "marky");

// Deliberate read-only door through the Emburse wall: the AEEA Analyst needs the
// live knowledge base, which lives in the separate ~/Emburse workspace.
const EMBURSE_AEEA = path.join(HOME, "Emburse", "AEEA");

function seedAssistants(): Assistant[] {
  const now = Date.now();
  return [
    {
      id: randomUUID(),
      // Reads the real AEEA kb, but writes only to its own directory.
      knowledgeRoot: path.join(KNOWLEDGE_HOME, "aeea-analyst"),
      readableDirs: [EMBURSE_AEEA],
      name: "AEEA Analyst",
      description:
        "Tracks the AEEA workstreams — Propensity IQ, platform access, meetings, and the knowledge base.",
      systemPrompt: [
        "You help track the AEEA programme at Emburse: Propensity IQ, the data platform,",
        "Educate Day, homegrown tools, and the enrichment platform integrations.",
        "",
        "The knowledge base lives on disk. Read it before answering — do not guess at",
        "project state. Cite the file you took a fact from.",
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
        "See commitments.md in your knowledge directory for the full convention.",
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
      knowledgeDirs: [MARKY],
      knowledgeRoot: EMBURSE_AEEA,
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
  let raw: string;
  try {
    raw = fs.readFileSync(DATA_FILE, "utf8");
  } catch {
    // No file yet — a first run. Seed it.
    const fresh = defaults();
    migrate(fresh);
    write(fresh);
    return fresh;
  }

  try {
    const parsed = JSON.parse(raw) as Store;
    if (migrate(parsed)) write(parsed);
    return parsed;
  } catch (e) {
    /**
     * The file exists but will not parse. This used to seed defaults and write
     * them straight over the top — which silently destroyed every thread,
     * message and question, left no backup, and presented a working app with
     * an empty history. There is no undo for that and no way to tell it
     * happened.
     *
     * Keep the bad file. Losing today's session to a truncated write is
     * survivable; losing everything with no trace is not.
     */
    const kept = `${DATA_FILE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(DATA_FILE, kept);
    } catch {
      // Even the copy failed — carry on rather than trapping the app in a
      // state it cannot start from.
    }
    console.error(
      `store.json could not be parsed (${(e as Error).message}). ` +
        `The unreadable file has been kept at ${kept} and a fresh store seeded.`,
    );
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

const LOCK_FILE = `${DATA_FILE}.lock`;
/** A writer that has held the lock longer than this is assumed dead. */
const LOCK_STALE_MS = 10_000;
/** Give up rather than hang a request forever. */
const LOCK_WAIT_MS = 5_000;

/** Block without spinning the CPU. Everything in this module is synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-PROCESS lock. It cannot be a module-level mutex: Next bundles each route
 * handler separately, so module state isn't shared between them — and the
 * Telegram relay is a different process entirely. `wx` is O_EXCL, which is
 * atomic on every filesystem we care about.
 */
function acquire(): () => void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch {
          // Already gone: a stale-lock breaker got here first. Nothing to undo.
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;

      // A process killed mid-write would otherwise wedge every future write.
      try {
        if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch {
        // The lock vanished while we were inspecting it — just retry.
      }

      if (Date.now() > deadline) {
        throw new Error(
          "store.json is locked by another writer and did not release in time.",
        );
      }
      sleepSync(25);
    }
  }
}

/**
 * Read-modify-write against disk, under a lock.
 *
 * The lock is the point. write() is atomic (tmp + rename) so the file can never
 * be truncated, but atomicity alone does not make read-modify-write safe: two
 * writers that both read, then both write, produce last-writer-wins over the
 * WHOLE store, and the loser's turn disappears with no error. That became a real
 * possibility the moment the Telegram relay started running alongside the UI.
 */
export function mutate(fn: (s: Store) => void): Store {
  const release = acquire();
  try {
    const s = read();
    fn(s);
    write(s);
    return s;
  } finally {
    release();
  }
}

export const uid = () => randomUUID();
