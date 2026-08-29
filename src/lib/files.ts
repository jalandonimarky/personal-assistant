import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { inboxDir } from "./scope";

/**
 * What the assistant can actually do with an uploaded file.
 *
 * THE DESIGN DECISION HERE. runClaude spawns the CLI with a text prompt on
 * stdin — there is no image-block API on this path — so an attachment becomes
 * visible by landing on disk somewhere the CLI can reach and being named in
 * the prompt. The Read tool opens text, images and PDFs directly, which covers
 * most of what people attach.
 *
 * It does NOT open .docx/.pptx/.xlsx. Those could be handled by the documents
 * MCP server's doc_read, but that tool exists only in Authoring mode and only
 * when the server is registered — so "summarise this deck" would fail in
 * Brainstorming, which is where people actually ask it. Instead we extract to
 * a plain-text sidecar AT UPLOAD TIME. The result is readable by the plain
 * Read tool, so it works in every mode, with no MCP server, and with no tool
 * grant. The original is kept alongside it for anything that wants the real
 * bytes later.
 */

export type FileKind = "text" | "image" | "pdf" | "extract" | "opaque";

/** Read opens these as-is. */
const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".rst", ".csv", ".tsv", ".json", ".jsonl",
  ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".css", ".scss",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".php",
  ".sh", ".bash", ".zsh", ".sql", ".graphql", ".proto", ".ini", ".conf",
  ".log", ".srt", ".vtt", ".ics",
]);

/** Read renders these visually. */
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * Read cannot parse these, but python-pptx / openpyxl / LibreOffice can.
 * Kept in step with read_any() in mcp/documents/src/build.py, which does the
 * actual work — this is the list of things worth handing it.
 */
const EXTRACT_EXT = new Set([
  ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls",
  ".odt", ".ods", ".odp", ".rtf", ".epub", ".pages", ".key", ".numbers",
]);

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function classify(filename: string): FileKind {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  if (EXTRACT_EXT.has(ext)) return "extract";
  return "opaque";
}

/** A sender-supplied filename is not a safe basename. Keep the shape, drop the teeth. */
export function safeName(filename: string): string {
  const base = path.basename(filename).replace(/[^A-Za-z0-9._-]+/g, "-");
  const trimmed = base.replace(/^[-.]+/, "").slice(0, 80);
  return trimmed || "file";
}

export interface StoredFile {
  name: string;
  path: string;
  kind: FileKind;
  bytes: number;
  /** Plain-text rendering of an office file, when one could be produced. */
  extractedPath?: string;
  /** Why an extraction did not happen, in words fit for the UI. */
  note?: string;
}

/**
 * PATH for the extractor's own subprocesses.
 *
 * build.py shells out to `soffice` for the formats openpyxl and python-pptx
 * don't cover. Under launchd the server inherits a near-empty PATH, so a
 * Homebrew LibreOffice at /opt/homebrew/bin is invisible and every .docx
 * conversion fails with ENOENT — which reads identically to "not installed".
 * The app already carries this convention for the CLI; the same applies here,
 * plus the .app bundle for a LibreOffice installed by drag-and-drop.
 */
const TOOL_PATH = [
  // Inherited PATH FIRST. Prepending /opt/homebrew/bin instead changes which
  // python3 wins, and the Homebrew one has neither openpyxl nor python-pptx —
  // so "fixing" soffice that way silently breaks .xlsx and .pptx, which are
  // the two formats that never needed LibreOffice in the first place.
  process.env.PATH ?? "",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/Applications/LibreOffice.app/Contents/MacOS",
]
  .filter(Boolean)
  .join(":");

/** Is soffice reachable at all? Distinguishes "absent" from "not on PATH". */
export function sofficeAvailable(): boolean {
  return TOOL_PATH.split(":").some((d) => {
    try {
      return d ? fs.existsSync(path.join(d, "soffice")) : false;
    } catch {
      return false;
    }
  });
}

/**
 * A python3 that actually has openpyxl and python-pptx.
 *
 * PATH order is not enough — a Homebrew or pyenv python3 is routinely first
 * while having neither library, so extraction fails with ModuleNotFoundError on
 * a machine where the tooling is installed and working. Probed once and cached;
 * the answer cannot change under us.
 */
let cachedPython: string | null = null;
function pythonBin(): string {
  if (cachedPython) return cachedPython;
  const candidates = [
    "/usr/local/bin/python3",
    "python3",
    "/opt/homebrew/bin/python3",
    "/usr/bin/python3",
  ];
  for (const bin of candidates) {
    const r = spawnSync(bin, ["-c", "import openpyxl, pptx"], {
      env: { ...process.env, PATH: TOOL_PATH },
      timeout: 20_000,
    });
    if (r.status === 0) {
      cachedPython = bin;
      return bin;
    }
  }
  // Nothing qualified: fall back so the failure comes from build.py with a
  // real message, rather than from here with a guess.
  cachedPython = "python3";
  return cachedPython;
}

/** Run build.py's `read` op. It already handles every format in EXTRACT_EXT. */
function extractText(absPath: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  return new Promise((resolve) => {
    const script = path.join(process.cwd(), "mcp/documents/src/build.py");
    if (!fs.existsSync(script)) {
      return resolve({ ok: false, error: "the documents helper is missing" });
    }

    const child = spawn(pythonBin(), [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: TOOL_PATH },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        resolve(
          parsed.ok
            ? { ok: true, text: String(parsed.text ?? "") }
            : { ok: false, error: String(parsed.error ?? "extraction failed") },
        );
      } catch {
        resolve({ ok: false, error: err.trim() || "extraction produced no output" });
      }
    });

    child.stdin.write(JSON.stringify({ op: "read", path: absPath }));
    child.stdin.end();
  });
}

/**
 * Write one upload into the shared inbox, extracting it if that is what makes
 * it readable. The stored basename is prefixed with a uuid so two people
 * uploading `notes.pdf` don't collide, while the visible name stays theirs.
 */
export async function storeUpload(
  filename: string,
  data: Buffer,
): Promise<StoredFile> {
  const name = safeName(filename);
  const kind = classify(name);
  const dest = path.join(inboxDir(), `${randomUUID().slice(0, 8)}-${name}`);
  fs.writeFileSync(dest, data);

  const stored: StoredFile = { name, path: dest, kind, bytes: data.length };

  if (kind === "extract") {
    const r = await extractText(dest);
    if (r.ok && (r.text ?? "").trim()) {
      const sidecar = `${dest}.extracted.md`;
      fs.writeFileSync(
        sidecar,
        `# Text extracted from ${name}\n\n` +
          `_Extracted on upload because the Read tool cannot parse this format._\n\n` +
          `${r.text}\n`,
        "utf8",
      );
      stored.extractedPath = sidecar;
    } else {
      // Worth saying out loud: LibreOffice does the heavy lifting for several
      // of these formats, and a machine without it fails only here.
      const missingSoffice = Boolean(r.error && /ENOENT|soffice|not found/i.test(r.error));
      stored.note = missingSoffice
        ? sofficeAvailable()
          ? "could not be converted — LibreOffice is installed but was not reachable from this process"
          : "could not be converted — this format needs LibreOffice (brew install --cask libreoffice)"
        : `could not be converted (${r.error ?? "unknown error"})`;
    }
  }

  return stored;
}

/**
 * The bracketed block appended to the user's message.
 *
 * Same convention the Telegram relay established: name the absolute path and
 * say plainly that the user expects it to have been opened. Silence about an
 * attachment reads to the user as the model ignoring them.
 */
export function describeAttachments(files: StoredFile[]): string {
  if (!files.length) return "";

  const lines = files.map((f) => {
    if (f.kind === "opaque") {
      return `- ${f.name} — saved at ${f.path}, but this format cannot be opened. Say so plainly rather than guessing at its contents.`;
    }
    if (f.kind === "extract") {
      return f.extractedPath
        ? `- ${f.name} — the original is at ${f.path}; its text has been extracted to ${f.extractedPath}. Read the extracted file.`
        : `- ${f.name} — saved at ${f.path}, but it ${f.note}. Say so plainly rather than guessing at its contents.`;
    }
    const what =
      f.kind === "image" ? "an image" : f.kind === "pdf" ? "a PDF" : "a text file";
    return `- ${f.name} — ${what} at ${f.path}. Open it with Read.`;
  });

  return (
    `[The user attached ${files.length === 1 ? "a file" : `${files.length} files`}:\n` +
    `${lines.join("\n")}\n` +
    `Open them before answering — they can see these and expect you to have looked.]`
  );
}
