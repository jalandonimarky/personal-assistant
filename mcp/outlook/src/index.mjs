#!/usr/bin/env node
import { accessToken, config, login, logout, status } from "./auth.mjs";
import { serve, cli } from "../../lib/rpc.mjs";

/**
 * Read-only Outlook MCP server. Zero dependencies.
 *
 * MCP over stdio is newline-delimited JSON-RPC 2.0, and Node 18+ ships fetch
 * and crypto, so there is no dependency tree here at all. That is deliberate:
 * this runs on a client's machines against their mail, and a server their
 * security team can read end-to-end in one sitting is far easier to approve
 * than one pulling a transitive graph from npm.
 *
 * READ-ONLY. There is no send, reply, forward, draft, move, or delete tool —
 * not disabled, absent. A model acting on a misread email cannot un-send it.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

const TOOLS = [
  {
    name: "outlook_search_messages",
    description:
      "Search the signed-in user's Outlook mailbox. Returns message summaries " +
      "(id, subject, sender, received time, preview). Use outlook_get_message " +
      "for the full body of a specific result.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free-text search over subject, body, and participants. Omit to list the most recent messages.",
        },
        top: {
          type: "integer",
          description: "How many messages to return (1-50, default 10).",
          minimum: 1,
          maximum: 50,
        },
      },
    },
  },
  {
    name: "outlook_get_message",
    description:
      "Read one Outlook message in full, by the id returned from outlook_search_messages.",
    inputSchema: {
      type: "object",
      properties: { messageId: { type: "string", description: "The message id." } },
      required: ["messageId"],
    },
  },
  {
    name: "outlook_list_folders",
    description: "List the mail folders in the signed-in user's mailbox.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function graph(path, params) {
  const token = await accessToken();
  const url = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      // Required by Graph for $search on messages.
      ConsistencyLevel: "eventual",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

const strip = (s, n = 400) =>
  (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function callTool(name, args = {}) {
  switch (name) {
    case "outlook_search_messages": {
      const top = Math.min(Math.max(Number(args.top) || 10, 1), 50);
      const params = {
        $top: top,
        $select: "id,subject,from,receivedDateTime,bodyPreview,isRead,webLink",
      };
      // $search and $orderby are mutually exclusive in Graph.
      if (args.query) params.$search = `"${String(args.query).replace(/"/g, "")}"`;
      else params.$orderby = "receivedDateTime desc";

      const data = await graph("/me/messages", params);
      const items = (data.value ?? []).map((m) => ({
        id: m.id,
        subject: m.subject || "(no subject)",
        from: m.from?.emailAddress?.address ?? null,
        fromName: m.from?.emailAddress?.name ?? null,
        received: m.receivedDateTime,
        unread: m.isRead === false,
        preview: strip(m.bodyPreview, 240),
      }));
      return { count: items.length, messages: items };
    }

    case "outlook_get_message": {
      if (!args.messageId) throw new Error("messageId is required.");
      const m = await graph(`/me/messages/${encodeURIComponent(args.messageId)}`, {
        $select:
          "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,webLink",
      });
      const addrs = (list) =>
        (list ?? []).map((r) => r.emailAddress?.address).filter(Boolean);
      return {
        id: m.id,
        subject: m.subject || "(no subject)",
        from: m.from?.emailAddress?.address ?? null,
        to: addrs(m.toRecipients),
        cc: addrs(m.ccRecipients),
        received: m.receivedDateTime,
        hasAttachments: Boolean(m.hasAttachments),
        body: strip(m.body?.content, 20000),
      };
    }

    case "outlook_list_folders": {
      const data = await graph("/me/mailFolders", { $top: 60 });
      return {
        folders: (data.value ?? []).map((f) => ({
          id: f.id,
          name: f.displayName,
          unread: f.unreadItemCount,
          total: f.totalItemCount,
        })),
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------- CLI ----------------

const arg = process.argv[2];

if (arg === "--login") {
  await cli(async () => {
    await login();
    const s = await status();
    console.log(`Signed in as ${s.account ?? "(unknown)"}`);
  });
} else if (arg === "--logout") {
  await cli(async () =>
    console.log((await logout()) ? "Signed out." : "Was not signed in."),
  );
} else if (arg === "--status") {
  await cli(async () => console.log(JSON.stringify(await status(), null, 2)));
} else if (arg === "--check-config") {
  await cli(async () => {
    const c = config();
    console.log(`tenant=${c.tenantId} client=${c.clientId} port=${c.port}`);
  });
} else {
  serve({
    name: "outlook-mcp",
    version: "0.1.0",
    tools: TOOLS,
    call: callTool,
    remedy:
      "Not signed in to Outlook. Run `npm run login` in mcp/outlook, or click " +
      "Sign in beside the Outlook connector.",
  });
}
