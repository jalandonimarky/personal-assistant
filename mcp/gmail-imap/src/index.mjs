#!/usr/bin/env node
import { serve, cli, notAuthenticated } from "../../lib/rpc.mjs";
import * as keychain from "../../lib/keychain.mjs";
import { Imap, fetchPayloads, parseHeaders, messageText } from "../../lib/imap.mjs";

/**
 * Gmail over IMAP, using an app password.
 *
 * WHY THIS RATHER THAN THE API. The API route costs a Google Cloud project, an
 * OAuth client and a consent screen before anyone can press a button; Gmail's
 * read scopes are in Google's restricted tier, so a shared client is not a
 * shortcut either. An app password costs one visit to the Google account's
 * security page. For a tool installed on a second machine, that is the
 * difference between "set up in a minute" and "set up this afternoon".
 *
 * READ-ONLY BY CONSTRUCTION, not by instruction. The mailbox is opened with
 * EXAMINE rather than SELECT, and the client implements no APPEND, STORE or
 * EXPUNGE at all. There is no code path here that can send, delete, flag or
 * even mark a message as read.
 *
 * The trade against the API version: no drafts and no label editing, since
 * both are writes. If those matter, use the connector or an OAuth client.
 */

const USER_SERVICE = "gmail-imap-user";
const PASS_SERVICE = "gmail-imap-app-password";

/** Gmail's virtual folder containing everything, so one search covers the lot. */
const ALL_MAIL = "[Gmail]/All Mail";

async function credentials() {
  const user = process.env.GMAIL_IMAP_USER || (await keychain.get(USER_SERVICE));
  const pass = process.env.GMAIL_IMAP_APP_PASSWORD || (await keychain.get(PASS_SERVICE));
  if (!user || !pass) {
    const e = new Error("No Gmail app password configured.");
    e.code = "NOT_AUTHENTICATED";
    throw e;
  }
  return { user, pass };
}

/** One connection per call. Turns are minutes apart; a pool would only rot. */
async function withImap(fn) {
  const { user, pass } = await credentials();
  const imap = new Imap({ user, pass });
  try {
    await imap.connect();
    await imap.login();
    return await fn(imap);
  } finally {
    imap.close();
  }
}

const HEADER_FIELDS = "BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)]";

const summarise = (uid, raw) => {
  const h = parseHeaders(raw);
  return {
    uid,
    from: h.from ?? null,
    to: h.to ?? null,
    subject: h.subject ?? null,
    date: h.date ?? null,
  };
};

const tools = [
  {
    name: "gmail_search",
    description:
      "Search the mailbox using Gmail's own query syntax (e.g. 'from:alice after:2026/08/01', " +
      "'has:attachment label:invoices') and return matching messages with sender, subject and date.",
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
    description:
      "Read one message in full by its uid, as returned by gmail_search, including body text.",
    inputSchema: {
      type: "object",
      properties: { uid: { type: "number" } },
      required: ["uid"],
    },
  },
  {
    name: "gmail_list_mailboxes",
    description: "List mailboxes and labels — in Gmail, labels appear as folders.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function call(name, args = {}) {
  switch (name) {
    case "gmail_search": {
      const limit = Math.min(Number(args.limit) || 20, 50);
      return withImap(async (imap) => {
        await imap.examine(ALL_MAIL);
        const uids = await imap.search(String(args.query ?? ""));
        if (!uids.length) return { count: 0, messages: [] };
        // SEARCH returns ascending uids; the newest are the interesting end.
        const wanted = uids.slice(-limit).reverse();
        const res = await imap.fetch(wanted, HEADER_FIELDS);
        const payloads = fetchPayloads(res);
        const messages = wanted
          .filter((u) => payloads.has(u))
          .map((u) => summarise(u, payloads.get(u)));
        return { count: messages.length, totalMatched: uids.length, messages };
      });
    }

    case "gmail_get_message": {
      const uid = Number(args.uid);
      if (!uid) throw new Error("uid is required.");
      return withImap(async (imap) => {
        await imap.examine(ALL_MAIL);
        const res = await imap.fetch([uid], "BODY.PEEK[]");
        const raw = fetchPayloads(res).get(uid);
        if (!raw) throw new Error(`No message with uid ${uid}.`);
        const { headers, text } = messageText(raw);
        return {
          uid,
          from: headers.from ?? null,
          to: headers.to ?? null,
          cc: headers.cc ?? null,
          subject: headers.subject ?? null,
          date: headers.date ?? null,
          body: text,
        };
      });
    }

    case "gmail_list_mailboxes":
      return withImap(async (imap) => ({ mailboxes: await imap.mailboxes() }));

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------- CLI ----------------

const arg = process.argv[2];

if (arg === "--login") {
  // Credentials arrive on stdin, never argv: argv is visible in the process
  // list and in shell history.
  await cli(async () => {
    const raw = await keychain.readSecret();
    const [user, pass] = raw.split(/\s+/, 2);
    if (!user || !pass) {
      throw new Error("Expected: <email> <app password> on stdin.");
    }
    await keychain.set(USER_SERVICE, user);
    await keychain.set(PASS_SERVICE, pass);
    // Prove it works now rather than failing later inside a turn.
    const imap = new Imap({ user, pass });
    try {
      await imap.connect();
      await imap.login();
    } finally {
      imap.close();
    }
    console.log(`Signed in to Gmail as ${user}.`);
  });
} else if (arg === "--logout") {
  await cli(async () => {
    const had = (await keychain.del(PASS_SERVICE)) || (await keychain.del(USER_SERVICE));
    await keychain.del(USER_SERVICE);
    console.log(had ? "Signed out of Gmail." : "Was not signed in.");
  });
} else if (arg === "--status") {
  await cli(async () => {
    try {
      const { user, pass } = await credentials();
      const imap = new Imap({ user, pass });
      try {
        await imap.connect();
        await imap.login();
        console.log(JSON.stringify({ signedIn: true, account: user }, null, 2));
      } finally {
        imap.close();
      }
    } catch {
      console.log(JSON.stringify({ signedIn: false }, null, 2));
      process.exitCode = 1;
    }
  });
} else {
  serve({
    name: "gmail-imap-mcp",
    version: "1.0.0",
    tools,
    call: async (n, a) => {
      try {
        return await call(n, a);
      } catch (e) {
        if (e.code === "NOT_AUTHENTICATED") {
          throw notAuthenticated("No Gmail app password configured.");
        }
        throw e;
      }
    },
    remedy:
      "Gmail is not configured. Open Settings → Connections and add your address " +
      "and a Google app password.",
  });
}
