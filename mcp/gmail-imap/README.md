# Gmail over IMAP — app password

Read and search Gmail with **no Google Cloud project, no OAuth client, no
client ID or secret**. One app password from your Google account is the whole
setup.

**Zero dependencies.** IMAP is a line protocol over TLS, and Node ships `tls`.

---

## Setup

1. **Turn on 2-Step Verification** on the Google account, if it isn't already.
   App passwords do not exist without it.
2. Go to **[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)**,
   create one (name it anything), and copy the 16 characters.
3. In the app: **Settings → Connections → Gmail (app password) → Add client**,
   paste your address and the password, then **Set up**.

That's it. No consent screen, no verification review, nothing to publish.

### When this won't work

- **No 2-Step Verification** — the app passwords page won't exist.
- **Workspace accounts where an admin has disabled app passwords.** Nothing you
  can do locally; use the connector or an OAuth client instead.
- Google has narrowed this path over the years. It works today; it is the
  option with the least certain shelf life, and that is the honest trade for
  needing no app registration.

---

## What it can and cannot do

| | |
|---|---|
| Search | Gmail's own query syntax — `from:`, `after:`, `has:attachment`, `label:` — via the `X-GM-RAW` extension |
| Read | Any message it finds, in full, including quoted-printable, base64, and HTML-only mail |
| List | Mailboxes and labels (Gmail shows labels as folders) |

**Read-only by construction, not by policy.** The mailbox is opened with
`EXAMINE` rather than `SELECT`, and the client implements no `APPEND`, `STORE`
or `EXPUNGE`. There is no code path that can send, delete, move, flag, or even
mark a message as read — so there is no write level to grant, and no flag that
could turn one on by accident.

If you want drafts or label editing, use the claude.ai connector or the OAuth
client servers in `mcp/google/` instead.

---

## Command line

```bash
printf 'you@gmail.com abcdefghijklmnop' | node mcp/gmail-imap/src/index.mjs --login
node mcp/gmail-imap/src/index.mjs --status    # {"signedIn":true,"account":"you@gmail.com"}
node mcp/gmail-imap/src/index.mjs --logout
```

Credentials arrive on **stdin**, never argv — argv is visible in the process
list and in shell history. They are stored in the macOS Keychain
(`gmail-imap-user`, `gmail-imap-app-password`), and `--login` proves the
password works before storing it, rather than letting it fail later inside a
turn.

## Tests

```bash
npm run test:imap
```

Covers the parts where the bugs actually are: IMAP literals that contain blank
lines and text resembling protocol, folded headers, RFC 2047 encoded words,
quoted-printable and base64 bodies, multipart messages, and HTML-only mail. The
network half needs a real mailbox and is not covered.
