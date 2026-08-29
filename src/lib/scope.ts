import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Assistant, Settings } from "./types";

/**
 * Per-assistant knowledge scoping.
 *
 * Each assistant owns exactly one writable directory. Everything else it can see
 * is read-only. This is what keeps one assistant's knowledge from being another's
 * — and keeps a shared reference directory (your existing notes) from being writable by
 * accident.
 */

export const KNOWLEDGE_HOME = path.join(process.cwd(), "knowledge");

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "assistant"
  );
}

/** The assistant's own directory — created on demand. */
export function rootFor(a: Assistant, settings: Settings): string {
  const root = a.knowledgeRoot?.trim() || settings.knowledgeRoot;
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Where inbound attachments land.
 *
 * There is no image-block API on this path — runClaude spawns the CLI with a
 * text prompt on stdin — but the CLI's Read tool opens images and PDFs from
 * disk. So a photo becomes visible by writing it somewhere every assistant can
 * reach and naming that path in the prompt.
 *
 * Deliberately outside the knowledge roots: an attachment is transient scratch,
 * and one assistant's knowledge directory is not the place to drop another's.
 */
export function inboxDir(): string {
  const dir =
    process.env.PA_INBOX_DIR?.trim() ||
    path.join(os.tmpdir(), "personal-assistant-inbox");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Directories passed to the CLI as --add-dir: the assistant's own root, any
 * read-only references, and the shared attachment inbox. Deduped, and the root
 * always comes first.
 */
export function readableFor(a: Assistant, settings: Settings): string[] {
  const root = rootFor(a, settings);
  const extra = a.readableDirs ?? settings.knowledgeDirs;
  return Array.from(new Set([root, ...extra, inboxDir(), outboxDir()]));
}

/** Resolve a relative path inside a root, refusing anything that escapes it. */
export function safeJoin(root: string, rel: string): string | null {
  const target = path.resolve(root, rel);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

/**
 * Seed a new assistant's directory with a README so the folder is never empty
 * and the assistant has somewhere obvious to write.
 */
export function seedRoot(root: string, assistantName: string): void {
  fs.mkdirSync(root, { recursive: true });
  const readme = path.join(root, "README.md");
  if (fs.existsSync(readme)) return;
  fs.writeFileSync(
    readme,
    [
      `# ${assistantName} — knowledge`,
      "",
      "This directory belongs to this assistant alone. It is the only place it can",
      "write, and the only thing shown in its Knowledge tab.",
      "",
      "Persist durable structure here — mappings, IDs, owners, decisions. Don't store",
      "values that go stale within days; store how to look them up instead.",
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * Working directory for the CLI — deliberately OUTSIDE any of the user's
 * projects.
 *
 * Claude Code discovers CLAUDE.md and project memory from its cwd and that
 * directory's ancestors. Running with cwd inside the user's workspace pulled
 * their entire personal memory into every assistant's context, which quietly
 * broke the isolation this whole module exists to provide — one assistant was
 * answering with facts about unrelated agents it had never been given.
 *
 * The assistant reaches its knowledge through --add-dir with absolute paths, so
 * cwd carries no useful information anyway.
 */
export function neutralCwd(): string {
  const dir = path.join(os.tmpdir(), "personal-assistant-cwd");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Where produced documents land — spreadsheets, decks, PDFs.
 *
 * Separate from the assistant's knowledge root on purpose: knowledge is prose
 * the assistant reasons over, and a 2 MB .pptx sitting in it would be indexed,
 * walked by the staleness scanner, and listed in the Knowledge tab for no
 * benefit. Outside the workspace for the same reason as neutralCwd().
 *
 * In ~/Documents, NOT os.tmpdir(). These are deliverables — the spreadsheet
 * someone asked for. A temp directory is periodically purged by macOS and is
 * a path no one can navigate to, so a file the assistant reported creating
 * would quietly stop existing. Override with PA_OUTBOX_DIR.
 */
export function outboxDir(): string {
  const dir =
    process.env.PA_OUTBOX_DIR?.trim() ||
    path.join(os.homedir(), "Documents", "Personal Assistant");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
