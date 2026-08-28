# Google MCP — Gmail and Drive

Read-only Gmail and Drive access for Claude Code, with **per-user sign-in**.
Each person signs in as themselves and reaches only their own mail and files.

**Zero dependencies.** MCP over stdio is newline-delimited JSON-RPC, and Node
18+ ships `fetch` and `crypto`, so there is no `node_modules` here at all. That
is deliberate — this runs on your machine against your mail, and a server you
can read end to end in one sitting is easier to trust than one pulling a
transitive dependency graph.

Two servers share one OAuth client and one auth module (`mcp/lib/google-auth.mjs`):

| Server | Script | Keychain entry |
|---|---|---|
| Gmail | `mcp/gmail/src/index.mjs` | `gmail-mcp-refresh-token` |
| Drive | `mcp/drive/src/index.mjs` | `drive-mcp-refresh-token` |

---

## Why not the claude.ai connector?

Because it isn't yours to fix. The account connector works, but it belongs to
the Claude account rather than to this app: on a machine that has never
authorised it there is nothing local to do, and the person has to go enable it
on the web first. That is a poor first run for a tool that is otherwise
self-contained.

Signing in here is the same shape as the Outlook server. The isolation is the
token, not our code.

---

## Setup — once, by you

You need one OAuth client from a Google Cloud project. It serves every user;
individuals do not need further approval afterwards.

1. **Create a project** at [console.cloud.google.com](https://console.cloud.google.com/).
2. **Enable the APIs** you want, under *APIs & Services → Library*:
   - **Gmail API**
   - **Google Drive API**
3. **Configure the consent screen** (*APIs & Services → OAuth consent screen*).
   - User type **Internal** if you have a Workspace org — nothing further needed.
   - **External** otherwise. While the app is in *Testing*, add each person as a
     test user. Note that **refresh tokens for an app in Testing expire after 7
     days** — for daily use, either publish the app or use Internal.
4. **Create the credential** (*APIs & Services → Credentials → Create
   credentials → OAuth client ID*):

   | Setting | Value |
   |---|---|
   | **Application type** | **Desktop app** |
   | **Name** | e.g. `Assistant — Google` |

   **It must be Desktop app. A Web application client will not work.**

   This is the installed-app flow: the server opens a loopback listener on a
   local port and Google redirects the browser back to it. Google permits that
   loopback redirect for Desktop clients only — any port, nothing to register.
   A Web application client rejects the same request with a bare
   **`400: … the server cannot process the request because it is malformed`**,
   which names no parameter and sends you hunting through a request that is
   in fact correct.

   So there is nothing to put in "Authorized redirect URIs", and nothing in
   "Authorized JavaScript origins" — a Desktop client shows neither. In
   particular the app's own port (4317) is not a redirect URI; it serves the
   web UI and has no part in OAuth.

5. **Paste it into the app.** Open **Settings → Connections**, press **Add
   client** on Gmail or Drive, and paste the client ID (and the secret, if your
   client type issued one). One client serves both — entering it on either card
   configures the other.

Then, on each card: **Set up** to register the server, then **Sign in**.

Nothing has to be exported into a shell. That matters because the app normally
runs as a launchd agent, which has no interactive shell to export into — an
earlier version told people to set `GOOGLE_CLIENT_ID` and restart, which was
advice they could not act on. The environment variable still wins if it is set,
for anyone running the dev server by hand.

Everything is stored in the macOS Keychain (`google-oauth-client-id`,
`google-oauth-client-secret`), and **Remove client** in the same panel clears it.

### On that "secret"

Google issues a client secret for Desktop app clients, and its own
documentation is explicit that the value **is not treated as confidential for
installed apps** — it ends up on every user's machine by definition. PKCE is
what actually binds an authorization code to the request that started it, and
this client always uses it. The secret is sent only when you set it.

---

## Scopes, and what they let the model do

| Server | Scopes | Consequence |
|---|---|---|
| Gmail | `gmail.readonly`, `gmail.compose`, `gmail.labels` | Read, draft, and create/rename/apply labels. **`gmail.send` is never requested**, so sending is un-grantable rather than merely unlisted. |
| Drive | `drive.readonly`, `drive.file` | Read anything in your Drive. Write only to files this assistant created — `drive.file` cannot touch a document it has never seen. |

Both also request `openid` and `email`, purely so the panel can show which
account is signed in.

The narrow Drive write scope is a deliberate trade: "update an existing file"
means one of ours. The alternative scope would hand write access to your entire
Drive, which is a lot to grant for the convenience of editing a file the
assistant did not make.

### Not offered at any level

Sending, replying, forwarding, trashing, marking spam, sharing, changing
permissions, deleting — **including deleting a label**, which strips it off
every message carrying it. `claude -p` is non-interactive and Authoring runs with
`acceptEdits`, so an allowed tool fires with no confirmation and no undo. A
draft a human sends is a different risk from a send a model performs.

---

## Command line

Each server exposes the three verbs the Connections panel drives:

```bash
node mcp/gmail/src/index.mjs --login     # browser opens, token to Keychain
node mcp/gmail/src/index.mjs --status    # {"signedIn":true,"account":"you@..."}
node mcp/gmail/src/index.mjs --logout    # clears the Keychain entry
```

Tokens live in the macOS Keychain — never in the repo, never in `store.json`,
never on argv. `GOOGLE_ACCOUNT` selects a named entry if you want more than one.

## Troubleshooting

**"No refresh token returned"** — Google returns one on first consent only.
Revoke the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
and sign in again.

**Signed out after a week** — the consent screen is in *Testing*. Publish it, or
switch to Internal.

**Bare "Error 400 … malformed"** with no parameter named — the OAuth client is
a **Web application** type. This flow needs **Desktop app**; Google only allows
the loopback redirect for that type. Create a new Desktop client and paste it
in; there is nothing to fix on the existing one.

**"Error 403: access_denied"**, or *"has not completed the Google verification
process… can only be accessed by developer-approved testers"* — the consent
screen is **External** and in **Testing**, so only listed testers may sign in.
Add yourself: *APIs & Services → OAuth consent screen* (newer console: *Google
Auth Platform → Audience*) → **Test users** → **+ Add users** → your address →
Save, then retry.

Reaching this error is a good sign: the client id, secret and redirect URI all
worked, or you would not have got as far as Google's consent screen.

**The Testing-mode tax.** Testers can sign in, but their **refresh tokens
expire after 7 days**, so you get signed out weekly. Two ways out:

- **Internal** — if the account belongs to a Google Workspace organisation,
  switch the consent screen to Internal. No testers to list, no 7-day expiry.
  This is the right answer whenever it is available.
- **Publish** — External + published removes the expiry, but Gmail's read
  scopes are in Google's *restricted* tier, so publishing means a verification
  review. Not worth it for a personal tool.
