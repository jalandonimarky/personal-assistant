#!/usr/bin/env node
import { serve, cli, notAuthenticated } from "../../lib/rpc.mjs";
import { makeConfig, api, runCli } from "../../lib/google-auth.mjs";

/**
 * Gmail MCP — read-only search and reading, plus drafts and labels.
 *
 * Per-user sign-in: each person signs in as themselves and reaches only their
 * own mailbox. Zero dependencies — Node 18+ ships fetch and crypto, and MCP
 * over stdio is newline-delimited JSON-RPC.
 *
 * WHAT IS DELIBERATELY ABSENT. There is no send, no reply, no forward, no
 * trash, no spam. `claude -p` is non-interactive and Authoring runs with
 * acceptEdits, so an allowed tool fires with no confirmation and no undo — a
 * draft a human sends is a different risk from a send a model performs. The
 * requested scopes match: gmail.readonly, gmail.compose, gmail.labels. There
 * is no gmail.send scope here, so a send is not merely unlisted, it is
 * un-grantable.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

const cfg = () =>
  makeConfig({
    service: "gmail-mcp-refresh-token",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.labels",
    ],
    port: 53683,
  });

// ---------------- Message shaping ----------------

const b64urlDecode = (s) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

const headerOf = (payload, name) =>
  payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

/**
 * Pull readable text out of a MIME tree. Prefers text/plain; falls back to
 * text/html with tags stripped, because plenty of mail has no plain part at
 * all and returning nothing reads as "the mail was empty".
 */
function bodyText(payload) {
  const parts = [];
  const walk = (node) => {
    if (!node) return;
    const data = node.body?.data;
    if (data && node.mimeType === "text/plain") parts.push(b64urlDecode(data));
    else if (data && node.mimeType === "text/html" && !parts.length) {
      parts.push(
        b64urlDecode(data)
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/\s+\n/g, "\n"),
      );
    }
    (node.parts ?? []).forEach(walk);
  };
  walk(payload);
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const summarise = (msg) => ({
  id: msg.id,
  threadId: msg.threadId,
  from: headerOf(msg.payload, "from"),
  to: headerOf(msg.payload, "to"),
  subject: headerOf(msg.payload, "subject"),
  date: headerOf(msg.payload, "date"),
  labelIds: msg.labelIds ?? [],
  snippet: msg.snippet,
});

const full = (msg) => ({ ...summarise(msg), body: bodyText(msg.payload) });

/** RFC 2822 message, base64url encoded, which is what the drafts API takes. */
function rawMessage({ to, cc, subject, body }) {
  const lines = [];
  if (to) lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(`Subject: ${subject ?? ""}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"', "", body ?? "");
  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---------------- Tools ----------------

const tools = [
  {
    name: "gmail_search",
    description:
      "Search the mailbox with Gmail query syntax (e.g. 'from:alice after:2026/08/01') " +
      "and return matching messages with sender, subject, date and snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query." },
        limit: { type: "number", description: "Max messages, default 20, cap 50." },
      },
      required: ["query"],
    },
  },
  {
    name: "gmail_get_message",
    description: "Read one message in full, including its body text.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "gmail_get_thread",
    description: "Read every message in a thread, oldest first.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Thread id." } },
      required: ["id"],
    },
  },
  {
    name: "gmail_list_labels",
    description: "List the mailbox's labels and their ids.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "gmail_list_drafts",
    description: "List existing drafts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "gmail_create_draft",
    description:
      "Create a draft for the user to review and send themselves. This does not send anything.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        cc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["body"],
    },
  },
  {
    name: "gmail_update_draft",
    description: "Replace the contents of a draft this assistant created.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Draft id." },
        to: { type: "string" },
        cc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["id", "body"],
    },
  },
  {
    name: "gmail_modify_labels",
    description:
      "Add or remove labels on a message. Accepts label names or ids — names are " +
      "resolved for you. Reversible, and never deletes mail.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Message id." },
        add: { type: "array", items: { type: "string" }, description: "Label names or ids to add." },
        remove: {
          type: "array",
          items: { type: "string" },
          description: "Label names or ids to remove.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "gmail_create_label",
    description: "Create a new label. Fails plainly if one with that name already exists.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Label name. Use 'Parent/Child' to nest." } },
      required: ["name"],
    },
  },
  {
    name: "gmail_update_label",
    description: "Rename an existing label. The label keeps its id, so nothing loses it.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Current label name or id." },
        name: { type: "string", description: "New name." },
      },
      required: ["label", "name"],
    },
  },
];

/** Labels by id and by lowercased name, so callers can pass either. */
async function labelIndex(c) {
  const r = await api(c, `${API}/labels`);
  const byId = new Map();
  const byName = new Map();
  for (const l of r.labels ?? []) {
    const rec = { id: l.id, name: l.name, type: l.type };
    byId.set(l.id, rec);
    byName.set(l.name.toLowerCase(), rec);
  }
  return { byId, byName };
}

async function call(name, args = {}) {
  const c = await cfg();

  switch (name) {
    case "gmail_search": {
      const limit = Math.min(Number(args.limit) || 20, 50);
      const list = await api(
        c,
        `${API}/messages?${new URLSearchParams({ q: args.query ?? "", maxResults: String(limit) })}`,
      );
      const ids = (list.messages ?? []).map((m) => m.id);
      // Gmail's list endpoint returns ids only, so each hit costs a fetch.
      const messages = await Promise.all(
        ids.map((id) => api(c, `${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)),
      );
      return { count: messages.length, messages: messages.map(summarise) };
    }

    case "gmail_get_message":
      return full(await api(c, `${API}/messages/${encodeURIComponent(args.id)}?format=full`));

    case "gmail_get_thread": {
      const t = await api(c, `${API}/threads/${encodeURIComponent(args.id)}?format=full`);
      return { id: t.id, messages: (t.messages ?? []).map(full) };
    }

    case "gmail_list_labels": {
      const r = await api(c, `${API}/labels`);
      return {
        labels: (r.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type })),
      };
    }

    case "gmail_list_drafts": {
      const r = await api(c, `${API}/drafts`);
      return { drafts: (r.drafts ?? []).map((d) => ({ id: d.id, messageId: d.message?.id })) };
    }

    case "gmail_create_draft": {
      const r = await api(c, `${API}/drafts`, {
        method: "POST",
        body: JSON.stringify({ message: { raw: rawMessage(args) } }),
      });
      return { created: r.id, messageId: r.message?.id, note: "Draft only — nothing was sent." };
    }

    case "gmail_update_draft": {
      const r = await api(c, `${API}/drafts/${encodeURIComponent(args.id)}`, {
        method: "PUT",
        body: JSON.stringify({ message: { raw: rawMessage(args) } }),
      });
      return { updated: r.id, note: "Draft only — nothing was sent." };
    }

    case "gmail_modify_labels": {
      // Models reach for the label they can see, which is the name. Resolving
      // here turns a confusing 400 from Gmail into either the right call or a
      // sentence saying which label does not exist.
      const known = await labelIndex(c);
      const resolve = (list) =>
        (list ?? []).map((v) => {
          const hit = known.byId.get(v) ?? known.byName.get(v.toLowerCase());
          if (!hit) {
            throw new Error(
              `No label called "${v}". Existing labels: ${[...known.byName.values()]
                .map((l) => l.name)
                .slice(0, 30)
                .join(", ")}. Create it with gmail_create_label first.`,
            );
          }
          return hit.id;
        });

      const r = await api(c, `${API}/messages/${encodeURIComponent(args.id)}/modify`, {
        method: "POST",
        body: JSON.stringify({
          addLabelIds: resolve(args.add),
          removeLabelIds: resolve(args.remove),
        }),
      });
      return { id: r.id, labelIds: r.labelIds };
    }

    case "gmail_create_label": {
      const name = String(args.name ?? "").trim();
      if (!name) throw new Error("A label name is required.");
      const known = await labelIndex(c);
      if (known.byName.has(name.toLowerCase())) {
        const existing = known.byName.get(name.toLowerCase());
        return { existing: existing.id, name: existing.name, note: "Already exists — nothing created." };
      }
      const r = await api(c, `${API}/labels`, {
        method: "POST",
        body: JSON.stringify({
          name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        }),
      });
      return { created: r.id, name: r.name };
    }

    case "gmail_update_label": {
      const known = await labelIndex(c);
      const target =
        known.byId.get(String(args.label)) ?? known.byName.get(String(args.label).toLowerCase());
      if (!target) throw new Error(`No label called "${args.label}".`);
      if (target.type === "system") {
        throw new Error(`"${target.name}" is a system label and cannot be renamed.`);
      }
      const r = await api(c, `${API}/labels/${encodeURIComponent(target.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: String(args.name) }),
      });
      return { id: r.id, name: r.name, previousName: target.name };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------- Entry ----------------

const arg = process.argv[2];
if (arg?.startsWith("--")) {
  await cli(async () => {
    const handled = await runCli(await cfg(), "Gmail", arg, {
      openBrowser: !process.argv.includes("--no-browser"),
    });
    if (!handled) throw new Error(`Unknown flag: ${arg}`);
  });
} else {
  serve({
    name: "gmail-mcp",
    version: "1.0.0",
    tools,
    call: async (n, a) => {
      try {
        return await call(n, a);
      } catch (e) {
        if (e.code === "NOT_AUTHENTICATED") throw notAuthenticated("Not signed in to Gmail.");
        throw e;
      }
    },
    remedy: "Not signed in to Gmail. Open Settings → Connections and sign in.",
  });
}
