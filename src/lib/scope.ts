import fs from "node:fs";
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
 * Directories passed to the CLI as --add-dir: the assistant's own root plus any
 * read-only references. Deduped, and the root always comes first.
 */
export function readableFor(a: Assistant, settings: Settings): string[] {
  const root = rootFor(a, settings);
  const extra = a.readableDirs ?? settings.knowledgeDirs;
  return Array.from(new Set([root, ...extra]));
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
