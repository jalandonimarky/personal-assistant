# Outlook MCP

Read-only Microsoft Outlook access for Claude Code, with **per-user sign-in**.
Each person signs in as themselves and reaches only their own mailbox.

**Zero dependencies.** MCP over stdio is newline-delimited JSON-RPC, and Node 18+
ships `fetch` and `crypto`, so there is no `node_modules` here at all. That is
deliberate — this runs on your machines against your mail, and a server your
security team can read end to end in one sitting is easier to approve than one
pulling a transitive dependency graph.

---

## What IT needs to do — once

An app registration in Microsoft Entra ID. One registration serves everyone;
individual users do not need further approval afterwards.

| Setting | Value |
|---|---|
| **Name** | e.g. `Assistant — Outlook (read-only)` |
| **Account types** | Single tenant |
| **Platform** | **Mobile and desktop applications** (public client) |
| **Redirect URI** | `http://localhost:53682/callback` |
| **Allow public client flows** | **Yes** |
| **API permissions** | Microsoft Graph → *Delegated*: `Mail.Read`, `offline_access`, `User.Read` |
| **Admin consent** | Grant once for the tenant |
| **Client secret** | **None. Do not create one.** |

### Why no client secret

This is a public client using **PKCE**. A secret would have to be copied onto
every user's machine, where it is readable by anyone with that account — a
credential leak with extra steps. PKCE exists precisely so desktop apps do not
need one, and its absence means there is no shared secret to rotate or leak.

### Why these permissions and no others

`Mail.Read` is **delegated**, not application. The server can only ever see the
mailbox of the person who signed in — it cannot read anyone else's, and it does
not have tenant-wide access.

`Mail.Send`, `Mail.ReadWrite`, and `Mail.ReadBasic.All` are **not requested**.
There is no tool in this server that sends, replies, forwards, drafts, moves, or
deletes anything. Those tools are absent, not disabled.

Hand IT the two values from the registration:

- **Directory (tenant) ID**
- **Application (client) ID**

---

## What each user does — once

```bash
export OUTLOOK_TENANT_ID=<directory-tenant-id>
export OUTLOOK_CLIENT_ID=<application-client-id>

claude mcp add outlook -e OUTLOOK_TENANT_ID=$OUTLOOK_TENANT_ID \
                       -e OUTLOOK_CLIENT_ID=$OUTLOOK_CLIENT_ID \
                       -- node /absolute/path/to/mcp/outlook/src/index.mjs

npm run login      # opens the browser, sign in as yourself
npm run status     # confirms which account is connected
```

`npm run login` opens the normal Microsoft sign-in page — including MFA and any
conditional-access policy, since it is the standard flow. Nothing about
authentication is handled by this code; it only receives the result.

To disconnect: `npm run logout`.

---

## Where the token lives

The refresh token is stored in the **macOS Keychain**, service
`outlook-mcp-refresh-token`. Never in this repo, never in the assistant's
`data/store.json`, never in a dotfile.

Each user's token is their own, which is what makes per-user isolation real: the
scoping is the credential, not our code.

Microsoft rotates refresh tokens on use, so the new one is written back on every
refresh. Revoking access in Entra ID or Microsoft 365 takes effect immediately —
the next refresh fails and the tools report "not signed in".

---

## Tools

| Tool | Does |
|---|---|
| `outlook_search_messages` | Search the mailbox; returns id, subject, sender, time, preview |
| `outlook_get_message` | Read one message in full by id |
| `outlook_list_folders` | List mail folders with unread and total counts |

**There is no fourth tool.** Sending, replying, forwarding, drafting, moving,
labelling, and deleting have no implementation here. A model acting on a
misread email cannot un-send it, so the capability does not exist to be misused.

---

## Verifying it without an account

The protocol layer runs without any credentials:

```bash
printf '%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 | node src/index.mjs
```

Should list exactly the three tools above. A `tools/call` without signing in
returns a "not signed in" message rather than failing the turn.

---

## Limits

- **macOS only** — token storage uses the system Keychain via `security`.
- Requires **Node 18+** for built-in `fetch`.
- `$search` returns Graph's relevance ordering; it cannot be combined with an
  explicit sort. With no query, results are newest first.
- Message bodies are truncated at 20,000 characters to avoid exhausting the
  model's context on a single long thread.
