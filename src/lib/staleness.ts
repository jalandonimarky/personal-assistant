import fs from "node:fs";
import path from "node:path";

/**
 * Commitment staleness scanning.
 *
 * Detection is deliberately deterministic and model-free: dates come off disk,
 * days are counted in TypeScript. The model's job (see /api/pulse) is only to
 * prioritise and narrate what this scan already found — so a digest can never
 * invent a date or quietly lose an item.
 *
 * The convention a commitment is written in:
 *
 *   - [ ] Send the vendor the field mapping @sam moved:2026-08-01 blocked:data export
 *
 * Everything but the text is optional. `moved:` is what makes staleness exact;
 * without it the file's mtime is used instead and the result is marked inferred.
 */

/** Days since last movement before an item changes bucket. Tune here. */
export const AGING_AFTER = 7;
export const STALE_AFTER = 14;
export const COLD_AFTER = 30;

export type Bucket = "fresh" | "aging" | "stale" | "cold";

export interface Commitment {
  /** Path relative to the assistant's knowledge root. */
  file: string;
  /** 1-indexed, so `file:line` lands on the item. */
  line: number;
  text: string;
  owner: string | null;
  blockedBy: string | null;
  due: string | null;
  /** ISO date the item last moved. */
  lastMoved: string;
  /** True when lastMoved came from file mtime, not an explicit `moved:` stamp. */
  movedInferred: boolean;
  done: boolean;
  daysSince: number;
  /** Days past due; 0 or negative when not overdue. */
  daysOverdue: number;
  bucket: Bucket;
}

export interface Scan {
  root: string;
  scannedAt: number;
  /** Markdown files read. */
  files: number;
  /** Open commitments, worst first. */
  open: Commitment[];
  done: number;
  /** Markdown files holding no commitments at all — convention coverage gaps. */
  uncovered: string[];
  counts: Record<Bucket, number> & { open: number; overdue: number };
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "data"]);
const MARKDOWN = /\.(md|markdown)$/i;
const MAX_DEPTH = 6;

/* ------------------------------- parsing -------------------------------- */

const TASK = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
// Longer keys first — JS alternation is leftmost-first, so `last-moved` must
// precede `moved` or it would match as a bare `moved` with a `last-` prefix.
const META_KEY = /\b(last-moved|lastmoved|blocked-by|blocked|moved|needs|owner|due)\s*:/gi;
const HANDLE = /(^|\s)@([A-Za-z][A-Za-z0-9._-]*)/;
const TRAILING_SEP = /[\s—–·|,;-]+$/;

/**
 * Split a task body into its leading text and its `key: value` metadata.
 * A value runs to the start of the next key, so `blocked:data export`
 * keeps its spaces without needing quotes.
 */
function parseMeta(body: string): { head: string; meta: Record<string, string> } {
  const keys = [...body.matchAll(META_KEY)];
  const meta: Record<string, string> = {};

  keys.forEach((m, i) => {
    const from = m.index! + m[0].length;
    const to = i + 1 < keys.length ? keys[i + 1].index! : body.length;
    const key = m[1].toLowerCase();
    meta[key] = body.slice(from, to).trim().replace(TRAILING_SEP, "");
  });

  return { head: keys.length ? body.slice(0, keys[0].index!) : body, meta };
}

/** Accepts YYYY-MM-DD and YYYY/M/D. Returns ISO, or null if unparseable. */
export function parseDate(value: string | undefined | null): string | null {
  if (!value) return null;
  const m = value.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return Number.isNaN(Date.parse(`${iso}T12:00:00Z`)) ? null : iso;
}

/** Local calendar date as ISO — the reference point for "how many days ago". */
export function todayIso(now: Date = new Date()): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Whole days between two ISO dates. Both are anchored at noon UTC so daylight
 * saving can never round a boundary the wrong way.
 */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T12:00:00Z`);
  const b = Date.parse(`${toIso}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function bucketFor(daysSince: number): Bucket {
  if (daysSince >= COLD_AFTER) return "cold";
  if (daysSince >= STALE_AFTER) return "stale";
  if (daysSince >= AGING_AFTER) return "aging";
  return "fresh";
}

/**
 * Parse one file's commitments. Fenced code blocks are skipped so the examples
 * in a convention document don't register as real commitments.
 */
export function parseFile(
  content: string,
  relFile: string,
  mtimeIso: string,
  today: string,
): Commitment[] {
  const out: Commitment[] = [];
  let fenced = false;

  content.split(/\r?\n/).forEach((raw, i) => {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;

    const task = raw.match(TASK);
    if (!task) return;

    const done = task[1].toLowerCase() === "x";
    const body = task[2];
    const { head, meta } = parseMeta(body);

    const stamped = parseDate(meta["moved"] ?? meta["last-moved"] ?? meta["lastmoved"]);
    const lastMoved = stamped ?? mtimeIso;
    const due = parseDate(meta["due"]);

    const handle = head.match(HANDLE) ?? body.match(HANDLE);
    const owner = meta["owner"] || (handle ? handle[2] : null);

    const text =
      head
        .replace(HANDLE, "")
        .replace(TRAILING_SEP, "")
        .trim() || body.trim();

    const daysSince = daysBetween(lastMoved, today);

    out.push({
      file: relFile,
      line: i + 1,
      text,
      owner: owner || null,
      blockedBy: meta["blocked"] || meta["blocked-by"] || meta["needs"] || null,
      due,
      lastMoved,
      movedInferred: stamped === null,
      done,
      daysSince,
      daysOverdue: due ? daysBetween(due, today) : 0,
      bucket: bucketFor(daysSince),
    });
  });

  return out;
}

/* -------------------------------- walking ------------------------------- */

function walk(dir: string, root: string, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, root, depth + 1));
    else if (MARKDOWN.test(e.name)) out.push(path.relative(root, full));
  }
  return out;
}

/** Worst first: overdue by the most, then quietest, then oldest stamp. */
function severity(a: Commitment, b: Commitment): number {
  if (a.daysOverdue > 0 || b.daysOverdue > 0) {
    if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
  }
  if (b.daysSince !== a.daysSince) return b.daysSince - a.daysSince;
  return a.file.localeCompare(b.file);
}

export function scanRoot(root: string, now: Date = new Date()): Scan {
  const today = todayIso(now);
  const files = walk(root, root).sort();

  const all: Commitment[] = [];
  const uncovered: string[] = [];

  for (const rel of files) {
    const full = path.join(root, rel);
    let content: string;
    let mtimeIso: string;
    try {
      content = fs.readFileSync(full, "utf8");
      mtimeIso = todayIso(fs.statSync(full).mtime);
    } catch {
      continue;
    }
    const found = parseFile(content, rel, mtimeIso, today);
    if (found.length === 0) uncovered.push(rel);
    all.push(...found);
  }

  const open = all.filter((c) => !c.done).sort(severity);

  const counts = {
    open: open.length,
    overdue: open.filter((c) => c.daysOverdue > 0).length,
    cold: open.filter((c) => c.bucket === "cold").length,
    stale: open.filter((c) => c.bucket === "stale").length,
    aging: open.filter((c) => c.bucket === "aging").length,
    fresh: open.filter((c) => c.bucket === "fresh").length,
  };

  return {
    root,
    scannedAt: now.getTime(),
    files: files.length,
    open,
    done: all.length - open.length,
    uncovered,
    counts,
  };
}

/* ------------------------------- rendering ------------------------------ */

/** Compact, token-cheap rendering of the scan for the digest prompt. */
export function renderScan(scan: Scan, limit = 60): string {
  if (scan.open.length === 0) {
    return `No open commitments found across ${scan.files} markdown file(s).`;
  }

  const lines = scan.open.slice(0, limit).map((c) => {
    const bits = [
      `[${c.bucket}${c.daysOverdue > 0 ? `, overdue ${c.daysOverdue}d` : ""}]`,
      c.text,
      `— quiet ${c.daysSince}d (last moved ${c.lastMoved}${c.movedInferred ? ", inferred from file mtime" : ""})`,
    ];
    if (c.owner) bits.push(`— owner ${c.owner}`);
    if (c.blockedBy) bits.push(`— blocked on ${c.blockedBy}`);
    if (c.due) bits.push(`— due ${c.due}`);
    bits.push(`— ${c.file}:${c.line}`);
    return bits.join(" ");
  });

  const omitted = scan.open.length - lines.length;
  if (omitted > 0) lines.push(`…and ${omitted} more, less severe.`);

  return lines.join("\n");
}
