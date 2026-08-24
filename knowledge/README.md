# knowledge/

Each assistant owns exactly one directory in here — created on first use, named
after the assistant. That directory is the **only** place it can write.

Everything an assistant writes is gitignored. This file is the exception, and
it exists to be copied: drop a copy into an assistant's directory so it knows
the filing conventions when it *reads*, not only when it writes.

---

## Where things go

Ingested sources are filed by kind. Follow these paths and headings exactly.
The shape is what makes this base searchable later, and Pulse matches `moved:`
and `due:` **literally** — reword the task-line syntax and the commitment is
silently dropped rather than flagged.

| Kind | Path | Structure | Task lines |
|---|---|---|---|
| Meeting | `meetings/YYYY-MM-DD-<slug>.md` | Decisions · Actions (with owner) · Open questions · Risks | yes |
| Slack / email thread | `threads/YYYY-MM-DD-<slug>.md` | What was asked · What was agreed · Who owns what · Still open | yes |
| Document or deck | `references/<slug>.md` | What it claims · Figures, each with its source locator · What could not be sourced | **no** |
| Decision | `decisions/YYYY-MM-DD-<slug>.md` | Context · Options considered · What was chosen · Why · What would change it | **no** |

References are undated on purpose: re-ingesting the same document should update
it, not fork a second copy.

**Task lines only where the table allows them**, and only for commitments
actually made in the source. A deck records what is true, not what anyone
committed to — inventing a task line there hands Pulse a commitment nobody made.

```
- [ ] <what> @<owner> moved:YYYY-MM-DD due:YYYY-MM-DD
```

Only the text is required. `moved:` is the one that matters — without it Pulse
falls back to the file's mtime and marks the row *inferred*.
