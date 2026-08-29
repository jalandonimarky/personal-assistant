#!/usr/bin/env node
import { serve, cli, notAuthenticated } from "../../lib/rpc.mjs";
import { makeConfig, api, apiText, runCli } from "../../lib/google-auth.mjs";

/**
 * Google Drive MCP — search and read, plus creating and updating files.
 *
 * Per-user sign-in: each person signs in as themselves and reaches only their
 * own Drive. Zero dependencies.
 *
 * SCOPES, AND THE ONE THING THEY CHANGE. Reading uses drive.readonly. Writing
 * uses drive.file, which grants access ONLY to files this app created — not to
 * everything in the Drive. That is a deliberate narrowing: it means the write
 * level cannot overwrite a document the assistant has never seen, at the cost
 * that "update an existing file" means one of ours. Worth stating plainly,
 * because the alternative scope would hand write access to the entire Drive.
 *
 * There is no share, no permissions change, and no delete — outward-facing and
 * irreversible actions are not offered at any level.
 */

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

const cfg = () =>
  makeConfig({
    service: "drive-mcp-refresh-token",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
    port: 53684,
  });

const FIELDS = "id,name,mimeType,modifiedTime,size,owners(displayName,emailAddress),webViewLink";

/**
 * Google-native files have no bytes to download — they must be exported. A
 * synced local folder cannot do this at all: Docs and Sheets sync as .gdoc /
 * .gsheet stubs holding a document id, not the document.
 */
const EXPORT_AS = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

const tools = [
  {
    name: "drive_search",
    description:
      "Search Drive by name or full text and return matching files with id, type and modified time.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for in the name or contents." },
        limit: { type: "number", description: "Max files, default 20, cap 50." },
      },
      required: ["query"],
    },
  },
  {
    name: "drive_list_recent",
    description: "List recently modified files, newest first.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Default 20, cap 50." } },
    },
  },
  {
    name: "drive_get_metadata",
    description: "Details of one file: name, type, size, owners, modified time, link.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "drive_read_file",
    description:
      "Read a file's contents as text. Google Docs, Sheets and Slides are exported to text or CSV automatically.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "drive_create_file",
    description:
      "Create a new text file in Drive, optionally inside a folder. Creates; never overwrites.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        content: { type: "string" },
        mimeType: { type: "string", description: "Default text/plain." },
        folderId: { type: "string", description: "Optional parent folder id." },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "drive_update_file",
    description:
      "Replace the contents of a file this assistant created. Cannot touch files it did not create.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, content: { type: "string" } },
      required: ["id", "content"],
    },
  },
  {
    name: "drive_copy_file",
    description: "Copy a file, leaving the original untouched.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string", description: "Name for the copy." } },
      required: ["id"],
    },
  },
];

async function call(name, args = {}) {
  const c = await cfg();

  switch (name) {
    case "drive_search": {
      const limit = Math.min(Number(args.limit) || 20, 50);
      const q = String(args.query ?? "").replace(/'/g, "\\'");
      const r = await api(
        c,
        `${API}/files?${new URLSearchParams({
          q: `(name contains '${q}' or fullText contains '${q}') and trashed = false`,
          pageSize: String(limit),
          fields: `files(${FIELDS})`,
          orderBy: "modifiedTime desc",
        })}`,
      );
      return { count: (r.files ?? []).length, files: r.files ?? [] };
    }

    case "drive_list_recent": {
      const limit = Math.min(Number(args.limit) || 20, 50);
      const r = await api(
        c,
        `${API}/files?${new URLSearchParams({
          q: "trashed = false",
          pageSize: String(limit),
          fields: `files(${FIELDS})`,
          orderBy: "modifiedTime desc",
        })}`,
      );
      return { files: r.files ?? [] };
    }

    case "drive_get_metadata":
      return api(
        c,
        `${API}/files/${encodeURIComponent(args.id)}?${new URLSearchParams({ fields: FIELDS })}`,
      );

    case "drive_read_file": {
      const meta = await api(
        c,
        `${API}/files/${encodeURIComponent(args.id)}?${new URLSearchParams({ fields: "id,name,mimeType" })}`,
      );
      const exportAs = EXPORT_AS[meta.mimeType];
      const text = exportAs
        ? await apiText(
            c,
            `${API}/files/${encodeURIComponent(args.id)}/export?${new URLSearchParams({ mimeType: exportAs })}`,
          )
        : await apiText(c, `${API}/files/${encodeURIComponent(args.id)}?alt=media`);
      // Cap the payload: a 40 MB export would blow the turn's context.
      return {
        id: meta.id,
        name: meta.name,
        mimeType: meta.mimeType,
        exportedAs: exportAs ?? null,
        truncated: text.length > 200_000,
        text: text.slice(0, 200_000),
      };
    }

    case "drive_create_file": {
      const meta = {
        name: args.name,
        ...(args.folderId ? { parents: [args.folderId] } : {}),
      };
      const boundary = `pa-${Date.now()}`;
      const body =
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(meta)}\r\n` +
        `--${boundary}\r\ncontent-type: ${args.mimeType || "text/plain"}\r\n\r\n` +
        `${args.content ?? ""}\r\n--${boundary}--`;
      const r = await api(c, `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, {
        method: "POST",
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        body,
      });
      return { created: r.id, name: r.name, link: r.webViewLink };
    }

    case "drive_update_file": {
      const r = await api(
        c,
        `${UPLOAD}/files/${encodeURIComponent(args.id)}?uploadType=media&fields=${FIELDS}`,
        {
          method: "PATCH",
          headers: { "content-type": "text/plain" },
          body: args.content ?? "",
        },
      );
      return { updated: r.id, name: r.name, link: r.webViewLink };
    }

    case "drive_copy_file": {
      const r = await api(c, `${API}/files/${encodeURIComponent(args.id)}/copy?fields=${FIELDS}`, {
        method: "POST",
        body: JSON.stringify(args.name ? { name: args.name } : {}),
      });
      return { created: r.id, name: r.name, link: r.webViewLink };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const arg = process.argv[2];
if (arg?.startsWith("--")) {
  await cli(async () => {
    const handled = await runCli(await cfg(), "Google Drive", arg, {
      openBrowser: !process.argv.includes("--no-browser"),
    });
    if (!handled) throw new Error(`Unknown flag: ${arg}`);
  });
} else {
  serve({
    name: "drive-mcp",
    version: "1.0.0",
    tools,
    call: async (n, a) => {
      try {
        return await call(n, a);
      } catch (e) {
        if (e.code === "NOT_AUTHENTICATED") throw notAuthenticated("Not signed in to Google Drive.");
        throw e;
      }
    },
    remedy: "Not signed in to Google Drive. Open Settings → Connections and sign in.",
  });
}
