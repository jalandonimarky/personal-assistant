# Personal Assistant

A local web UI over the **`claude` CLI** — multiple assistants, each with its own
isolated context and its own knowledge directory on disk.

**It runs on your Claude Code subscription, not the API.** Every turn shells out to
`claude -p`, which inherits the auth Claude Code already has. No API key, no
per-token billing. The per-turn cost shown under each reply is what the turn
*would* have cost at API rates, labelled as such.

```bash
npm install
npm run dev        # → http://localhost:4317
```

**Requirements:** Node 18+, and [Claude Code](https://claude.com/claude-code)
installed and authenticated (`claude` on your `PATH`). Nothing else — no database,
no API key, no native dependencies.

> ⚠️ If `ANTHROPIC_API_KEY` is exported in the shell running the dev server, the
> CLI switches to API billing and those "not billed" figures become real.

---

## How it works

| Concept | What it actually is |
|---|---|
| **Assistant** | A system prompt + its own discussions + one writable directory. Isolated context. |
| **Discussion** | A `claude` CLI session. First turn claims `--session-id`, every turn after uses `--resume`. |
| **Mode** | Which model and which tools are allowed for that turn. |
| **Ingest** | A filing instruction that turns a pasted meeting, thread, deck, or decision into a structured file. |
| **Connections** | External services, off by default, granted per conversation at a chosen access level. |
| **Documents** | Spreadsheets, decks and documents, produced natively in Authoring. |
| **Questions** | Clarifying questions the assistant parked instead of blocking on. |
| **Pulse** | Commitments that have gone quiet, detected off disk. |

### The central design decision

**Thread memory belongs to the CLI, not this app.** The first turn claims a
`--session-id`; every turn after resumes it. The app **never resends conversation
history** — so context management, compaction, and token budgeting required no
code at all. This is the single biggest reason the whole thing is small.

---

## Modes

| Mode | Model | Tools | For |
|---|---|---|---|
| **Brainstorming** | Sonnet | Read · Glob · Grep | Discuss ideas and options. Cannot write. |
| **Authoring** | Opus | + Write · Edit | Produce and persist deliverables. |
| **Critique** | Opus | Read · Glob · Grep | Argue against the current thinking. Cannot write. |

Read-only is enforced through `--allowedTools`, not by asking the model nicely.

Critique deliberately runs a **different model** from Brainstorming. Running the
critic on the same model as the generator produces agreement, not challenge.

Defined in `src/lib/modes.ts` — rename or add freely.

---

## Ingest

In Authoring mode, a bar above the composer offers a type selector and an
**Ingest →** button. It writes a filing instruction into the message box; you
paste your raw material underneath it and send. Nothing is hidden — the
instruction is visible and editable before it goes.

| Type | Files to | Task lines |
|---|---|---|
| Meeting | `meetings/YYYY-MM-DD-<slug>.md` | yes |
| Slack / email thread | `threads/YYYY-MM-DD-<slug>.md` | yes |
| Document or deck | `references/<slug>.md` | **no** |
| Decision | `decisions/YYYY-MM-DD-<slug>.md` | **no** |

**Auto-detect** hands the assistant the whole table and asks which row fits. It
picks the destination; the format is fixed either way — because Pulse matches
`moved:` and `due:` literally, and a model improvising `moved on:` produces a
commitment that is silently never tracked.

**Why two types refuse task lines.** Tell the model to "turn every commitment
into a task line", hand it a slide deck, and it will invent commitments nobody
made — which then arrive in Pulse wearing an owner and a due date, looking
exactly as authoritative as the real ones. So those types are told explicitly
not to emit them.

Types live in `src/lib/ingest.ts`. Add one entry and the selector, the prompt,
and the in-app help table all pick it up. Full write-up at `/docs/ingest` while
the app is running, or `docs/ingest.html`.

---

## Connections

External services are reachable per conversation, and only when you switch them
on. The panel shows each one's real state — connected, sign-in required, set-up
required — rather than a checkbox that looks identical whether or not anything
is serving the tools behind it.

| | Read | Write |
|---|---|---|
| **Gmail** | search and read mail | drafts and labels |
| **Google Drive** | search and read files, including native Docs and Sheets | create, update, copy |
| **GitHub** | repos, issues, PRs, commits, files, PR status | comment on an issue or PR |
| **Vercel** | projects, deployments, build logs | — |
| **Outlook** | search and read mail | — |

**Two rules, both enforced in code rather than requested.**

*Read is the default, and write needs Authoring.* Grants carry a level, and
`toolsFor()` drops write-level tools unless the mode already holds `Write` — so
a write grant sent to a read-only mode degrades to read instead of elevating it.

*Irreversible and outward-facing actions are not offered at any level.* Sending
mail, sharing a Drive file, merging, deploying, deleting — none of these have an
entry. `claude -p` is non-interactive and Authoring runs `acceptEdits`, so an
allowed tool fires with **no confirmation and no undo**. The grant is the
confirmation. A draft you send yourself is a different risk from a send the
model performs.

Grants are never persisted and clear when you switch thread, assistant or tab.

Gmail and Drive come from connectors already attached to your Claude account.
GitHub and Vercel take a token you supply, stored in your OS keychain — the app
never holds it. Outlook runs a local server against Microsoft Graph with
per-user sign-in; see `mcp/outlook/README.md`.

Services are defined in `src/lib/services.ts`.

---

## Documents

In Authoring, the assistant can produce real deliverables:

- **Spreadsheets** (`.xlsx`) from structured rows
- **Presentations** (`.pptx`) from slides, bullets and speaker notes
- **Documents** (`.docx`) from headings, text, lists and tables
- and read existing `.xlsx`, `.pptx`, `.docx`, `.pdf` and text files to work from

This is **not** a connection to switch on. Producing a deliverable is part of
what Authoring is, so the tools live in the mode's tool list beside `Write` and
`Edit` — and are absent from every read-only mode for the same reason those are.

Every tool takes structured data, never a command: the model supplies rows and
bullets, and the server decides what runs. Output is confined to an outbox
outside your workspace. Requires `python3` with `openpyxl` and `python-pptx`,
plus LibreOffice for `.docx`.

Served by `mcp/documents/`.

---

## Telegram

`bot/telegram.mjs` relays a Telegram chat to the app, so the assistant is usable
from a phone.

**Long polling, deliberately** — the relay calls out to Telegram and asks for
messages. Nothing has to reach in: no open port, no tunnel, no public URL. It
works on cellular and other people's networks for the same reason.

```bash
security add-generic-password -U -s telegram-bot-token -a default -w '<token>'
security add-generic-password -U -s telegram-allowed-ids -a default -w '<your-id>'
npm run bot
```

A bot token is effectively discoverable and anyone can message a bot, so the
allowlist is not optional — without it a stranger reaches your assistant, your
knowledge base and your connectors.

Defaults to Brainstorming (read-only) and no connectors: you should not be able
to authorise file writes by tapping a phone keyboard. `/mode authoring` is an
explicit act. Commands: `/new`, `/who`, `/assistants`, `/use`, `/mode`, `/help`.

---

## The Questions tab

The assistant is told: when something is genuinely ambiguous, **don't stop and
ask**. Answer with your best reading, then append a `<questions>` block. That
block is stripped from the reply and queued.

The conversation keeps moving, and nothing gets silently assumed.

**Closing the loop.** Answering a question sends your reply back into the
*originating discussion* — the assistant re-reads with the ambiguity resolved and
gives the corrected version in full. The answer is stored next to the question,
so the assumption and its correction stay together.

---

## The Pulse tab

Telling an assistant to "surface things that have gone quiet" doesn't make it
happen — nothing fires unless you ask. Pulse is the part that fires.

**Detection is deterministic; the model only narrates.** A scanner in
`src/lib/staleness.ts` reads the knowledge directory, parses commitments, and
counts days in TypeScript. Only then is that scan handed to the model, which
decides what deserves a nudge. The model is told the scan is authoritative, so a
digest can't invent a date or quietly drop an item.

Write a commitment as a markdown task line:

```
- [ ] Send the vendor the field mapping @sam moved:2026-08-01 blocked:data export due:2026-08-20
```

Only the text is required. A value runs to the next key, so `blocked:` can hold
spaces without quoting. Tick the box to close it. Fenced code blocks are skipped,
so documenting the convention doesn't create phantom commitments.

| Quiet for | Bucket |
|---|---|
| < 7 days | fresh |
| 7–13 | aging |
| 14–29 | stale |
| ≥ 30 | cold |

Overdue items sort above everything. Thresholds live at the top of
`src/lib/staleness.ts`. The tab badge counts **cold + stale + overdue** only.

The scan itself costs nothing and re-runs on every load, so the badge is never
stale. Pressing **Run sweep** is what spends a model call.

### Scheduling it

Next has no durable scheduler and an in-process timer dies with the dev server,
so scheduling lives in the OS. The app exposes the trigger:

```bash
npm run pulse            # sweep every assistant, skipping any with nothing quiet
npm run pulse -- --force # sweep even when everything is fresh
```

`scripts/pulse.plist` is a launchd agent (macOS) that runs it daily at 08:00.
Install instructions are in the file's comments — replace `__REPO__` with this
repo's absolute path first. It needs the app running; if it isn't, the script
says so and exits cleanly.

The scanner has tests — `npm run test:pulse`. It's the one piece that must not
be wrong, since everything the model says downstream is built on it.

---

## Knowledge scoping

Each assistant owns **one writable directory** under `knowledge/<slug>/`. Read
access is separate and opt-in: an assistant can be given reference directories it
may read but never write.

Every path is resolved and checked before any read or write — the model picks
those filenames, so they're treated as untrusted, and `../` escapes are refused.
Logic in `src/lib/scope.ts`.

Point the seeded assistants at your own notes by editing `NOTES` in
`src/lib/store.ts` before first run, or `data/store.json` afterwards.

---

## Data

`data/store.json` — assistants, threads, messages, questions, sweeps, settings.
Plain JSON, inspectable, **gitignored**. Delete it to reset; it reseeds three
assistants on next boot.

Conversation history itself lives in Claude Code's own session storage, keyed by
the `sessionId` on each thread.

Sweep records are an event log — the counts on each are what the scan saw that
day and are never refreshed. Live staleness is always re-derived from disk.

---

## Layout

```
src/app/            Next.js routes — one API handler per resource
  api/chat/         Shells out to the claude CLI
  api/pulse/        Runs a sweep; detection already done in lib/staleness
  docs/[slug]/      Serves docs/ so the UI can link to it
src/lib/
  claude.ts         Builds the argv and parses the CLI's JSON output
  services.ts       Connectors, their tools, and the read/write gate
  modes.ts          Model + allowed tools + instruction, per mode
  ingest.ts         Ingest types as data, and the prompt they render
  scope.ts          Path confinement — the security boundary
  staleness.ts      Deterministic commitment scanner (tested)
  store.ts          Read-modify-write JSON persistence
mcp/                Zero-dependency MCP servers
  lib/              Shared JSON-RPC transport and keychain access
  documents/        Spreadsheets, decks, documents
  github/           Repos, issues, PRs, commits, files
  vercel/           Projects, deployments, build logs
  outlook/          Microsoft Graph, per-user sign-in
bot/telegram.mjs    Telegram relay
scripts/            Pulse trigger, launchd agent, scanner tests
docs/               Technical references, served at /docs/<slug>
knowledge/          One directory per assistant. Gitignored.
```

### Things learned building it

- **No module-level cache in `store.ts`.** Next bundles each route handler
  separately in dev, so a shared in-memory cache isn't shared — one route
  clobbers another's write. Every read hits disk; every mutation is
  read-modify-write.
- **`export const maxDuration` must be a literal.** `60 * 20` fails the build.
- **The CLI's working directory leaks context.** Claude Code discovers CLAUDE.md
  and project memory from its cwd and that directory's ancestors, so running with
  cwd inside your workspace pulls your personal memory into every assistant —
  quietly defeating the isolation. It runs from a neutral directory instead.
- **Promisified `execFile` ignores `input`.** That option belongs to
  `execFileSync`; passing it leaves the child waiting on a stdin that never
  closes, so it hangs until the timeout rather than failing.
- **The prompt goes over stdin**, not argv — avoids length limits and shell
  interpolation.
- **Deleting an assistant keeps its knowledge folder** on disk, by design.
- **`seedAssistants()` only runs when `data/store.json` is absent.** Editing the
  seed changes nothing for assistants that already exist. Anything an existing
  assistant needs to know belongs in its knowledge directory, not the seed.
- If a stale `.next` produces a bizarre build error, `rm -rf .next` before
  investigating app code.

---

## Not built

- Streaming replies — the reply lands when the CLI returns
- Editing an assistant in-app (edit `data/store.json`)
- Cross-assistant knowledge search
- Authentication — the dev server binds to all interfaces with no login, so
  anyone who can reach the port has full access. Bind to loopback
  (`next dev -H 127.0.0.1`) unless you add a gate.
- Windows support — token storage uses the macOS Keychain

---

## License

MIT — see [LICENSE](LICENSE).
