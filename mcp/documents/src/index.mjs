#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { serve, cli } from "../../lib/rpc.mjs";

const run = promisify(execFile);
const BUILD = path.join(import.meta.dirname, "build.py");

/**
 * Document production — spreadsheets, decks, documents, PDFs.
 *
 * Exists so the assistant can produce real deliverables without being granted a
 * shell. Every tool takes STRUCTURED DATA and this server decides what runs; the
 * model never supplies a command, a path outside the outbox, or a template.
 *
 * Writes are confined to DOCUMENTS_ROOT. The model chooses filenames, so they
 * are treated as untrusted: basename only, resolved, and rejected if the result
 * escapes the root.
 */

const ROOT =
  process.env.DOCUMENTS_ROOT || path.join(os.tmpdir(), "personal-assistant-outbox");
fs.mkdirSync(ROOT, { recursive: true });

/** Resolve a model-supplied filename inside the outbox, or refuse. */
function safeOut(name, ext) {
  const base = path.basename(String(name || "untitled")).replace(/[^\w.\- ]+/g, "_");
  const withExt = base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
  const full = path.resolve(ROOT, withExt);
  if (path.dirname(full) !== path.resolve(ROOT)) throw new Error("Path escapes the outbox.");
  return full;
}

/** Reads may reach anywhere the assistant was already given; writes may not. */
function safeIn(p) {
  const full = path.resolve(String(p));
  if (!fs.existsSync(full)) throw new Error(`No such file: ${full}`);
  return full;
}

/**
 * The spec goes over stdin, so it must be spawn(): promisified execFile has no
 * `input` option, and passing one silently leaves the child waiting on a stdin
 * that never closes — it hangs until the timeout rather than failing.
 */
function py(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [BUILD], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.trim().split("\n").pop();
      if (!line) return reject(new Error(err.trim().slice(-400) || "no output"));
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        return reject(new Error(`unparseable: ${line.slice(0, 200)}`));
      }
      if (!r.ok) return reject(new Error(r.error));
      resolve(r);
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const TOOLS = [
  {
    name: "doc_create_spreadsheet",
    description:
      "Create an .xlsx workbook. Each sheet is rows of cells; the first row is " +
      "treated as a bold, frozen header unless header is false.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Name only, no directories." },
        sheets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              header: { type: "boolean" },
              rows: { type: "array", items: { type: "array" } },
            },
            required: ["name", "rows"],
          },
        },
      },
      required: ["filename", "sheets"],
    },
  },
  {
    name: "doc_create_presentation",
    description:
      "Create a .pptx deck. One entry per slide: a title, optional bullets, " +
      "optional speaker notes. First slide renders as a title slide if it has no bullets.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string" },
        slides: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              subtitle: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
              notes: { type: "string" },
            },
            required: ["title"],
          },
        },
      },
      required: ["filename", "slides"],
    },
  },
  {
    name: "doc_create_document",
    description:
      "Create a .docx. Blocks are typed: paragraph, heading, bullets, or table.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string" },
        title: { type: "string" },
        blocks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["p", "heading", "bullets", "table"] },
              text: { type: "string" },
              items: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array" } },
            },
          },
        },
      },
      required: ["filename", "blocks"],
    },
  },
  {
    name: "doc_read",
    description:
      "Extract the text of an existing .xlsx, .pptx, .docx, .pdf, .csv or text " +
      "file so its contents can be reconciled or summarised.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path." } },
      required: ["path"],
    },
  },
  {
    name: "doc_list",
    description: "List documents already produced, newest first.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function call(name, args = {}) {
  switch (name) {
    case "doc_create_spreadsheet": {
      const out = safeOut(args.filename, ".xlsx");
      const r = await py({ op: "spreadsheet", out, spec: { sheets: args.sheets ?? [] } });
      return { created: out, sheets: r.sheets };
    }
    case "doc_create_presentation": {
      const out = safeOut(args.filename, ".pptx");
      const r = await py({ op: "presentation", out, spec: { slides: args.slides ?? [] } });
      return { created: out, slides: r.slides };
    }
    case "doc_create_document": {
      const out = safeOut(args.filename, ".docx");
      const r = await py({
        op: "document",
        out,
        spec: { title: args.title, blocks: args.blocks ?? [] },
      });
      return { created: out, blocks: r.blocks };
    }
    case "doc_read": {
      const r = await py({ op: "read", path: safeIn(args.path) });
      return { path: args.path, text: r.text };
    }
    case "doc_list": {
      const files = fs
        .readdirSync(ROOT)
        .map((f) => ({ f, s: fs.statSync(path.join(ROOT, f)) }))
        .filter((x) => x.s.isFile())
        .sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)
        .slice(0, 50)
        .map((x) => ({
          name: x.f,
          path: path.join(ROOT, x.f),
          kb: Math.round(x.s.size / 1024),
          modified: new Date(x.s.mtimeMs).toISOString(),
        }));
      return { outbox: ROOT, files };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

if (process.argv[2] === "--status") {
  await cli(async () => {
    const checks = {};
    for (const [k, mod] of [["openpyxl", "openpyxl"], ["python-pptx", "pptx"]]) {
      checks[k] = await run("python3", ["-c", `import ${mod}`])
        .then(() => true)
        .catch(() => false);
    }
    checks.soffice = await run("soffice", ["--version"], { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    // No credential to hold: this server works on local files only.
    console.log(JSON.stringify({ signedIn: true, account: "local", ...checks }, null, 2));
  });
} else {
  serve({
    name: "documents-mcp",
    version: "0.1.0",
    tools: TOOLS,
    call,
    remedy: "Document tooling unavailable. Needs python3 with openpyxl and python-pptx, plus LibreOffice.",
  });
}
