"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "@/components/Markdown";
import type { Grant, Level } from "@/lib/services";
import {
  INGEST_OPTIONS,
  INGEST_TYPES,
  ingestPrompt,
  type IngestId,
} from "@/lib/ingest";

type ModeId = "brainstorming" | "authoring" | "critique" | "pulse";
type Bucket = "fresh" | "aging" | "stale" | "cold";
type SvcState = "ready" | "needs-auth" | "needs-setup" | "unavailable";
interface ServiceStatus {
  id: string;
  label: string;
  blurb: string;
  state: SvcState;
  detail: string;
  canRegister?: boolean;
  grants: string[];
  withheld: string[];
  writeGrants?: string[];
  writeNote?: string;
  hasWrite?: boolean;
  auth:
    | { kind: "account" }
    | { kind: "oauth" }
    | { kind: "token"; url: string; help: string };
}

interface Assistant {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  knowledgeRoot?: string;
  readableDirs?: string[];
  createdAt: number;
}
interface Thread {
  id: string;
  assistantId: string;
  title: string;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
}
interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  mode: ModeId | null;
  costUsd: number | null;
  createdAt: number;
}
interface Question {
  id: string;
  assistantId: string;
  threadId: string | null;
  text: string;
  answer?: string;
  answered: boolean;
  createdAt: number;
  answeredAt?: number;
}
interface Mode {
  id: ModeId;
  label: string;
  blurb: string;
  model: string;
}
interface Counts {
  open: number;
  overdue: number;
  cold: number;
  stale: number;
  aging: number;
  fresh: number;
}
interface Commitment {
  file: string;
  line: number;
  text: string;
  owner: string | null;
  blockedBy: string | null;
  due: string | null;
  lastMoved: string;
  movedInferred: boolean;
  daysSince: number;
  daysOverdue: number;
  bucket: Bucket;
}
interface Scan {
  root: string;
  scannedAt: number;
  files: number;
  open: Commitment[];
  done: number;
  uncovered: string[];
  counts: Counts;
}
interface Sweep {
  id: string;
  createdAt: number;
  digest: string;
  counts: Counts;
  costUsd: number | null;
}
interface State {
  assistants: Assistant[];
  threads: Thread[];
  messages: Message[];
  questions: Question[];
  modes: Mode[];
  pulse: Record<string, Counts>;
  settings: { knowledgeDirs: string[]; knowledgeRoot: string };
}

type Tab = "chat" | "pulse" | "questions" | "knowledge" | "settings";

const when = (ts: number) =>
  new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const day = (ts: number) =>
  new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const MODE_TOOLS: Record<ModeId, string> = {
  brainstorming: "Read · Glob · Grep",
  authoring: "Read · Glob · Grep · Write · Edit · Documents",
  critique: "Read · Glob · Grep",
  pulse: "Read · Glob · Grep",
};

const BUCKET_LABEL: Record<Bucket, string> = {
  cold: "Cold",
  stale: "Stale",
  aging: "Aging",
  fresh: "Fresh",
};

/** The convention, shown wherever a scan comes back empty. */
const CONVENTION =
  "- [ ] Send the vendor the field mapping @sam moved:2026-08-01 blocked:data export";

export default function Page() {
  const [state, setState] = useState<State | null>(null);
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [mode, setMode] = useState<ModeId>("brainstorming");
  const [ingest, setIngest] = useState<IngestId>("auto");
  const [ingestHelp, setIngestHelp] = useState(false);

  /**
   * External services unlocked for the NEXT turn. Deliberately not persisted
   * and not stored per-thread: access should be something you grant on purpose
   * in the moment, never something left switched on and forgotten. The effect
   * below clears it whenever you move.
   */
  const [services, setServices] = useState<Grant[]>([]);
  const [svcOpen, setSvcOpen] = useState(false);
  const [catalog, setCatalog] = useState<ServiceStatus[] | null>(null);
  const [svcBusy, setSvcBusy] = useState<string | null>(null);
  const [svcChecking, setSvcChecking] = useState(false);
  const [svcMsg, setSvcMsg] = useState<{ id: string; text: string; bad?: boolean } | null>(null);
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [tokenVal, setTokenVal] = useState("");

  /**
   * Probing costs ~6s (claude mcp list health-checks every server), so the
   * panel shows what it last knew and refreshes behind it rather than blanking.
   * `refresh` forces past the server's cache after an action changes something.
   */
  const loadCatalog = useCallback(async (refresh = false) => {
    setSvcChecking(true);
    try {
      const r = await fetch(`/api/services${refresh ? "?refresh=1" : ""}`, {
        cache: "no-store",
      });
      setCatalog((await r.json()).services ?? []);
    } catch {
      setCatalog((c) => c ?? []);
    } finally {
      setSvcChecking(false);
    }
  }, []);

  // Warmed on mount so the panel is usually populated before it is opened.
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    if (svcOpen) void loadCatalog();
  }, [svcOpen, loadCatalog]);

  useEffect(() => {
    if (!svcOpen) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setSvcOpen(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [svcOpen]);

  const svcAction = useCallback(
    async (id: string, action: string, token?: string) => {
      setSvcBusy(id);
      setSvcMsg(null);
      try {
        const r = await fetch("/api/services/connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, action, token }),
        });
        const d = await r.json();
        setSvcMsg({ id, text: d.error ?? d.message ?? "Done.", bad: !r.ok });
        if (r.ok) {
          setTokenFor(null);
          setTokenVal("");
          await loadCatalog(true);
        }
      } catch (e) {
        setSvcMsg({ id, text: String(e), bad: true });
      } finally {
        setSvcBusy(null);
      }
    },
    [loadCatalog],
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/state", { cache: "no-store" });
    const s: State = await r.json();
    setState(s);
    setAssistantId((cur) => cur ?? s.assistants[0]?.id ?? null);
    return s;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const assistant = useMemo(
    () => state?.assistants.find((a) => a.id === assistantId) ?? null,
    [state, assistantId],
  );

  const threads = useMemo(
    () =>
      (state?.threads ?? [])
        .filter((t) => t.assistantId === assistantId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [state, assistantId],
  );

  const messages = useMemo(
    () =>
      (state?.messages ?? [])
        .filter((m) => m.threadId === threadId)
        .sort((a, b) => a.createdAt - b.createdAt),
    [state, threadId],
  );

  const questions = useMemo(
    () =>
      (state?.questions ?? [])
        .filter((q) => q.assistantId === assistantId)
        .sort((a, b) => b.createdAt - a.createdAt),
    [state, assistantId],
  );
  const openQuestions = questions.filter((q) => !q.answered).length;

  // What the Pulse tab nags with: things that have actually gone quiet, not
  // every open item. Fresh and aging items don't earn a badge.
  const pulseCounts = assistantId ? state?.pulse?.[assistantId] : undefined;
  const needsAttention = pulseCounts
    ? pulseCounts.cold + pulseCounts.stale + pulseCounts.overdue
    : 0;

  // Keep a thread selected whenever the assistant has one.
  useEffect(() => {
    if (!threads.some((t) => t.id === threadId)) {
      setThreadId(threads[0]?.id ?? null);
    }
  }, [threads, threadId]);

  /**
   * Revoke on movement. Switching thread, assistant, or tab ends the context
   * you granted access for, so the grant ends with it. A reload clears it too,
   * since the state was never persisted in the first place.
   */
  useEffect(() => {
    setServices([]);
    setSvcOpen(false);
  }, [threadId, assistantId, tab]);

  const composer = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length, busy]);

  async function newThread() {
    if (!assistantId) return;
    const r = await fetch("/api/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assistantId }),
    });
    const t: Thread = await r.json();
    await load();
    setThreadId(t.id);
    setTab("chat");
  }

  async function send() {
    const content = draft.trim();
    if (!content || busy || !assistantId) return;

    let target = threadId;
    if (!target) {
      const r = await fetch("/api/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assistantId }),
      });
      const t: Thread = await r.json();
      target = t.id;
      setThreadId(t.id);
    }

    setDraft("");
    setBusy(true);
    // Show the user's turn immediately; the reply lands after the CLI returns.
    setState((s) =>
      s
        ? {
            ...s,
            messages: [
              ...s.messages,
              {
                id: `pending-${Date.now()}`,
                threadId: target!,
                role: "user",
                content,
                mode,
                costUsd: null,
                createdAt: Date.now(),
              },
            ],
          }
        : s,
    );

    try {
      await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: target, content, mode, services }),
      });
    } finally {
      await load();
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <div className="shell">
        <aside className="rail">
          <div>
            <h1>Personal Assistant</h1>
            <div className="tagline">Isolated contexts, reviewed answers</div>
          </div>
        </aside>
        <main className="main">
          <div className="empty">Loading…</div>
        </main>
      </div>
    );
  }

  const activeMode = state.modes.find((m) => m.id === mode) ?? state.modes[0];

  return (
    <div className="shell">
      {/* ---------------- Left rail ---------------- */}
      <aside className="rail">
        <div>
          <h1>Personal Assistant</h1>
          <div className="tagline">Isolated contexts, reviewed answers</div>
        </div>

        <div>
          <div className="rail-label">Model</div>
          <select
            className="mode-select"
            value={mode}
            onChange={(e) => setMode(e.target.value as ModeId)}
          >
            {state.modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <div className="mode-blurb">{activeMode?.blurb}</div>
        </div>

        <div>
          <button
            className="assistant-card new"
            onClick={() => {
              setCreating(true);
              setTab("chat");
            }}
          >
            <div className="name">+ New assistant</div>
            <div className="desc">Create a focused context</div>
          </button>

          {state.assistants.map((a) => (
            <button
              key={a.id}
              className={`assistant-card ${a.id === assistantId && !creating ? "active" : ""}`}
              onClick={() => {
                setCreating(false);
                setAssistantId(a.id);
                setThreadId(null);
                setTab("chat");
              }}
            >
              <div className="name">{a.name}</div>
              <div className="desc">{a.description}</div>
            </button>
          ))}
        </div>

        <div style={{ marginTop: "auto" }}>
          <button className="btn btn-sm" onClick={() => setTab("settings")}>
            Settings
          </button>
        </div>
      </aside>

      {/* ---------------- Main ---------------- */}
      <main className="main">
        {creating ? (
          <NewAssistant
            onCancel={() => setCreating(false)}
            onCreated={async (id) => {
              setCreating(false);
              await load();
              setAssistantId(id);
              setThreadId(null);
            }}
          />
        ) : !assistant ? (
          <div className="empty">Create an assistant to begin.</div>
        ) : (
          <>
            <div className="main-head">
              <div>
                <h2>{assistant.name}</h2>
                <div className="sub">{assistant.description}</div>
              </div>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  if (
                    !confirm(
                      `Delete "${assistant.name}"?\n\n` +
                        `Removes the assistant, its discussions and its questions.\n\n` +
                        `Its knowledge folder is KEPT on disk:\n${assistant.knowledgeRoot ?? "(default)"}\n\n` +
                        `Delete that folder yourself if you want the files gone.`,
                    )
                  )
                    return;
                  await fetch(`/api/assistants/${assistant.id}`, {
                    method: "DELETE",
                  });
                  setAssistantId(null);
                  setThreadId(null);
                  const s = await load();
                  setAssistantId(s.assistants[0]?.id ?? null);
                }}
              >
                Delete
              </button>
            </div>

            <div className="tabs">
              <button
                className={`tab ${tab === "chat" ? "active" : ""}`}
                onClick={() => setTab("chat")}
              >
                Chat
              </button>
              <button
                className={`tab ${tab === "pulse" ? "active" : ""}`}
                onClick={() => setTab("pulse")}
              >
                Pulse
                {needsAttention > 0 && (
                  <span className="count warn">{needsAttention}</span>
                )}
              </button>
              <button
                className={`tab ${tab === "questions" ? "active" : ""}`}
                onClick={() => setTab("questions")}
              >
                Questions
                {openQuestions > 0 && <span className="count">{openQuestions}</span>}
              </button>
              <button
                className={`tab ${tab === "knowledge" ? "active" : ""}`}
                onClick={() => setTab("knowledge")}
              >
                Knowledge
              </button>
            </div>

            {tab === "chat" && (
              <div className="chat-grid">
                <section className="pane">
                  <div className="pane-head">
                    <h3>Discussions</h3>
                    <button className="btn btn-sm" onClick={newThread}>
                      New
                    </button>
                  </div>
                  <div className="pane-body">
                    {threads.length === 0 && (
                      <div className="empty" style={{ padding: "12px 4px" }}>
                        No discussions yet.
                      </div>
                    )}
                    {threads.map((t) => (
                      <div
                        key={t.id}
                        className={`thread ${t.id === threadId ? "active" : ""}`}
                        onClick={() => setThreadId(t.id)}
                        role="button"
                      >
                        <div className="t">{t.title}</div>
                        <div className="d">{when(t.updatedAt)}</div>
                        <button
                          className="x"
                          title="Delete discussion"
                          onClick={async (e) => {
                            e.stopPropagation();
                            await fetch(`/api/threads?id=${t.id}`, {
                              method: "DELETE",
                            });
                            await load();
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="pane">
                  <div className="pane-body pad" ref={scroller}>
                    {messages.length === 0 && !busy && (
                      <div className="empty">
                        Using <b>{activeMode?.label}</b> until you change it.
                        Clarifying questions collect in the Questions tab instead of
                        interrupting chat.
                      </div>
                    )}

                    {messages.map((m) => (
                      <div key={m.id} className={`msg ${m.role}`}>
                        {m.role === "user" ? (
                          <>
                            <div className="who">You</div>
                            <div className="body">
                              <Markdown>{m.content}</Markdown>
                            </div>
                          </>
                        ) : (
                          <>
                            {m.mode && (
                              <div className="badge">
                                {state.modes.find((x) => x.id === m.mode)?.label ??
                                  m.mode}
                              </div>
                            )}
                            <div className="body">
                              <Markdown>{m.content}</Markdown>
                            </div>
                            {m.costUsd != null && (
                              <div
                                className="cost"
                                title="Not charged — you're on a subscription. This is what the turn would have cost at API rates."
                              >
                                ≈ ${m.costUsd.toFixed(4)} at API rates · not billed
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ))}

                    {busy && (
                      <div className="msg">
                        <div className="badge">{activeMode?.label}</div>
                        <div className="body dots" style={{ color: "var(--muted)" }}>
                          Working
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="composer">
                    {mode === "authoring" && (
                      <div className="write-bar">
                        <span>
                          <b>Authoring</b> — this mode can create and edit files.
                        </span>
                        <span className="write-bar-actions">
                          <select
                            className="ingest-select"
                            value={ingest}
                            onChange={(e) =>
                              setIngest(e.target.value as IngestId)
                            }
                            aria-label="What are you pasting?"
                          >
                            {INGEST_OPTIONS.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              // Computed per click, not at module load — a tab
                              // left open overnight would otherwise stamp
                              // yesterday into the filing instruction.
                              const today = new Date().toLocaleDateString("en-CA");
                              const tpl = ingestPrompt(ingest, today);
                              setDraft(tpl);
                              requestAnimationFrame(() => {
                                composer.current?.focus();
                                composer.current?.setSelectionRange(
                                  tpl.length,
                                  tpl.length,
                                );
                              });
                            }}
                          >
                            Ingest →
                          </button>
                          <button
                            className="help-dot"
                            onClick={() => setIngestHelp((v) => !v)}
                            aria-expanded={ingestHelp}
                            aria-label="How ingest works"
                            title="How ingest works"
                          >
                            ?
                          </button>
                        </span>
                      </div>
                    )}

                    {mode === "authoring" && ingestHelp && (
                      <div className="ingest-help">
                        <p>
                          <b>Ingest writes a filing instruction into the box
                          below.</b>{" "}
                          Nothing is sent until you press Send, and you can edit
                          or delete the instruction first — it has no special
                          status.
                        </p>
                        <ol>
                          <li>Choose what you&rsquo;re pasting, or leave it on Auto-detect.</li>
                          <li>
                            Press <b>Ingest →</b>. The instruction appears, cursor
                            at the bottom.
                          </li>
                          <li>Paste your raw material underneath it.</li>
                          <li>Send.</li>
                        </ol>
                        <p>
                          The assistant files it into <b>its own knowledge
                          directory only</b>, then opens its reply by saying
                          where it filed it and why.
                        </p>
                        {/* Derived from INGEST_TYPES so the help can never
                            drift from what the prompt actually says. */}
                        <table>
                          <thead>
                            <tr>
                              <th>What you paste</th>
                              <th>Lands in</th>
                              <th>Task lines</th>
                            </tr>
                          </thead>
                          <tbody>
                            {INGEST_TYPES.map((t) => (
                              <tr key={t.id}>
                                <td>{t.label}</td>
                                <td>
                                  <code>{t.file}</code>
                                </td>
                                <td>
                                  {t.commitments ? (
                                    "yes"
                                  ) : (
                                    <span className="no">no</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <p className="why">
                          <b>Why the last column matters.</b> Meetings and threads
                          contain commitments, so they produce{" "}
                          <code>- [ ]</code> lines that Pulse tracks. A deck or a
                          decision record doesn&rsquo;t — it records what is true,
                          not what anyone promised. Those types are told
                          explicitly not to write task lines, because an invented
                          one would show up in Pulse as a real commitment with a
                          real date beside it.
                        </p>
                        <p className="why">
                          <b>Auto-detect</b> hands the assistant this whole table
                          and asks which row fits. It picks the destination; the
                          format is fixed either way.
                        </p>
                        <p>
                          <a
                            className="doc-link"
                            href="/docs/ingest"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Full technical reference →
                          </a>
                        </p>
                      </div>
                    )}
                    <label>Message</label>
                    <textarea
                      ref={composer}
                      value={draft}
                      placeholder="Share an idea or issue to explore…"
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                    />
                    <div className="composer-row">
                      <button
                        className="btn btn-accent"
                        onClick={() => void send()}
                        disabled={busy || !draft.trim()}
                      >
                        {busy ? "Working…" : "Send"}
                      </button>
                      <div className="tools">
                        TOOLS <b>{MODE_TOOLS[mode]}</b>
                      </div>

                      <button
                        className={`connect-btn${services.length ? " on" : ""}`}
                        onClick={() => setSvcOpen(true)}
                      >
                        <span className="plug">⚯</span>
                        {services.length === 0
                          ? "Connect"
                          : services.some((g) => g.level === "write")
                            ? `${services.length} connected · write`
                            : `${services.length} connected`}
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {tab === "questions" && (
              <section className="pane">
                <div className="pane-head">
                  <h3>Questions</h3>
                  <span className="tools">
                    Parked so they don&apos;t interrupt the conversation
                  </span>
                </div>
                <div className="pane-body pad">
                  {questions.length === 0 && (
                    <div className="empty">
                      No open questions. When the assistant hits real ambiguity it
                      answers anyway and leaves the question here.
                    </div>
                  )}
                  {questions.map((q) => (
                    <QuestionItem
                      key={q.id}
                      q={q}
                      mode={mode}
                      threadTitle={
                        state.threads.find((t) => t.id === q.threadId)?.title ??
                        null
                      }
                      onGoToThread={() => {
                        if (q.threadId) {
                          setThreadId(q.threadId);
                          setTab("chat");
                        }
                      }}
                      onChanged={async (goToThread) => {
                        await load();
                        if (goToThread && q.threadId) {
                          setThreadId(q.threadId);
                          setTab("chat");
                        }
                      }}
                    />
                  ))}
                </div>
              </section>
            )}

            {tab === "pulse" && (
              <Pulse
                key={assistant.id}
                assistantId={assistant.id}
                onSwept={() => void load()}
              />
            )}

            {tab === "knowledge" && (
              <Knowledge key={assistant.id} assistantId={assistant.id} />
            )}
          </>
        )}

        {tab === "settings" && !creating && <Settings settings={state.settings} />}

        {svcOpen && (
          <div className="scrim" onClick={() => setSvcOpen(false)} role="presentation">
            <div
              className="connectors"
              role="dialog"
              aria-modal="true"
              aria-label="Connections"
              onClick={(e) => e.stopPropagation()}
            >
              <header>
                <div>
                  <h3>Connections</h3>
                  <p>
                    Granted for this conversation only — switching thread, assistant
                    or tab disconnects everything.
                  </p>
                </div>
                <div className="hdr-act">
                  <button
                    className="re"
                    onClick={() => void loadCatalog(true)}
                    disabled={svcChecking}
                    title="Re-check connections"
                  >
                    {svcChecking ? "Checking…" : "Re-check"}
                  </button>
                  <button className="x" onClick={() => setSvcOpen(false)} aria-label="Close">
                    ×
                  </button>
                </div>
              </header>

              {catalog === null ? (
                <div className="svc-loading">
                  Checking connections… this takes a few seconds the first time.
                </div>
              ) : (
                <ul className="svc-list">
                  {catalog.map((c) => {
                    const grant = services.find((g) => g.id === c.id);
                    const on = Boolean(grant);
                    // Write is offered only where the service has write tools
                    // AND the mode can write. The server enforces this too — the
                    // UI just avoids offering something that would be dropped.
                    const canWrite = Boolean(c.hasWrite) && mode === "authoring";
                    const ready = c.state === "ready";
                    const busy = svcBusy === c.id;
                    const msg = svcMsg?.id === c.id ? svcMsg : null;
                    return (
                      <li key={c.id} className={`svc-card ${c.state}`}>
                        <div className="svc-main">
                          <div className="svc-id">
                            <b>{c.label}</b>
                            <span className={`pip ${c.state}`}>
                              {ready
                                ? "Connected"
                                : c.state === "needs-auth"
                                  ? "Sign in required"
                                  : c.state === "needs-setup"
                                    ? "Set up required"
                                    : "Unavailable"}
                            </span>
                          </div>
                          <p className="svc-blurb">{c.blurb}</p>
                          <p className="svc-detail">{c.detail}</p>
                        </div>

                        <div className="svc-act">
                          {ready ? (
                            <button
                              className={`toggle${on ? " on" : ""}`}
                              role="switch"
                              aria-checked={on}
                              aria-label={`Use ${c.label} in this conversation`}
                              onClick={() =>
                                setServices((v) =>
                                  on
                                    ? v.filter((x) => x.id !== c.id)
                                    : [...v, { id: c.id, level: "read" as Level }],
                                )
                              }
                            >
                              <span className="knob" />
                            </button>
                          ) : c.state === "needs-setup" && c.canRegister ? (
                            <button
                              className="btn btn-sm"
                              disabled={busy}
                              onClick={() => void svcAction(c.id, "register")}
                            >
                              {busy ? "Setting up…" : "Set up"}
                            </button>
                          ) : c.state === "needs-auth" ? (
                            c.auth.kind === "token" ? (
                              <button
                                className="btn btn-sm"
                                onClick={() =>
                                  setTokenFor(tokenFor === c.id ? null : c.id)
                                }
                              >
                                Sign in
                              </button>
                            ) : (
                              <button
                                className="btn btn-sm"
                                disabled={busy}
                                onClick={() => void svcAction(c.id, "login")}
                              >
                                {busy ? "Waiting for browser…" : "Sign in"}
                              </button>
                            )
                          ) : null}
                        </div>

                        {tokenFor === c.id && c.auth.kind === "token" && (
                          <div className="svc-token">
                            <p>{c.auth.help}</p>
                            <div className="svc-token-row">
                              <input
                                type="password"
                                value={tokenVal}
                                placeholder="Paste token"
                                onChange={(e) => setTokenVal(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && tokenVal.trim())
                                    void svcAction(c.id, "login", tokenVal.trim());
                                }}
                              />
                              <button
                                className="btn btn-sm btn-accent"
                                disabled={busy || !tokenVal.trim()}
                                onClick={() => void svcAction(c.id, "login", tokenVal.trim())}
                              >
                                {busy ? "Saving…" : "Save"}
                              </button>
                            </div>
                            <a href={c.auth.url} target="_blank" rel="noreferrer">
                              Create a token →
                            </a>
                          </div>
                        )}

                        {on && (
                          <div className="svc-level">
                            <div className="seg">
                              <button
                                className={grant?.level === "read" ? "sel" : ""}
                                onClick={() =>
                                  setServices((v) =>
                                    v.map((x) =>
                                      x.id === c.id ? { ...x, level: "read" as Level } : x,
                                    ),
                                  )
                                }
                              >
                                Read
                              </button>
                              <button
                                className={grant?.level === "write" ? "sel" : ""}
                                disabled={!canWrite}
                                title={
                                  c.writeNote ??
                                  (mode !== "authoring"
                                    ? "Switch to Authoring — read-only modes cannot write."
                                    : undefined)
                                }
                                onClick={() =>
                                  setServices((v) =>
                                    v.map((x) =>
                                      x.id === c.id ? { ...x, level: "write" as Level } : x,
                                    ),
                                  )
                                }
                              >
                                Read + write
                              </button>
                            </div>

                            <ul className="scope">
                              {c.grants.slice(0, 2).map((g) => (
                                <li key={g} className="can">
                                  {g}
                                </li>
                              ))}
                              {grant?.level === "write" &&
                                (c.writeGrants ?? []).map((g) => (
                                  <li key={g} className="can w">
                                    {g}
                                  </li>
                                ))}
                              {c.withheld.slice(0, 2).map((w) => (
                                <li key={w} className="cannot">
                                  {w}
                                </li>
                              ))}
                            </ul>

                            {!canWrite && c.hasWrite && mode !== "authoring" && (
                              <p className="svc-hint">
                                Write is available in Authoring only. This mode is
                                read-only and cannot change anything.
                              </p>
                            )}
                            {c.writeNote && (
                              <p className="svc-hint">{c.writeNote}</p>
                            )}
                          </div>
                        )}

                        {msg && (
                          <p className={`svc-msg${msg.bad ? " bad" : ""}`}>{msg.text}</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              <footer>
                Read-only in every case. Anything read becomes part of the
                conversation, and conversations go to Anthropic.
              </footer>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function QuestionItem({
  q,
  mode,
  threadTitle,
  onChanged,
  onGoToThread,
}: {
  q: Question;
  mode: ModeId;
  threadTitle: string | null;
  onChanged: (goToThread: boolean) => void | Promise<void>;
  onGoToThread: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const text = answer.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await fetch("/api/questions/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId: q.id, answer: text, mode }),
      });
      setAnswer("");
      await onChanged(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`q-card ${q.answered ? "done" : ""}`}>
      <div className="q-top">
        <div className="qt">{q.text}</div>
        {q.answered && <span className="pill-done">Answered</span>}
      </div>

      <div className="qm">
        {when(q.createdAt)}
        {threadTitle && (
          <>
            {" · "}
            <button className="linky" onClick={onGoToThread}>
              {threadTitle}
            </button>
          </>
        )}
      </div>

      {q.answered ? (
        <>
          {q.answer && <div className="q-answer">{q.answer}</div>}
          <div className="q-actions">
            {q.threadId && (
              <button className="btn btn-sm" onClick={onGoToThread}>
                Open discussion
              </button>
            )}
            <button
              className="btn btn-sm"
              onClick={async () => {
                await fetch("/api/questions", {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ id: q.id, answered: false }),
                });
                await onChanged(false);
              }}
            >
              Reopen
            </button>
          </div>
        </>
      ) : (
        <>
          <textarea
            className="q-input"
            value={answer}
            placeholder="Answer this — the assistant will revise its reply in that discussion…"
            disabled={busy}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="q-actions">
            <button
              className="btn btn-sm btn-accent"
              disabled={busy || !answer.trim()}
              onClick={() => void submit()}
            >
              {busy ? "Regenerating…" : "Save answer & regenerate"}
            </button>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={async () => {
                await fetch("/api/questions", {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ id: q.id, answered: true }),
                });
                await onChanged(false);
              }}
            >
              Dismiss
            </button>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={async () => {
                await fetch(`/api/questions?id=${q.id}`, { method: "DELETE" });
                await onChanged(false);
              }}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function NewAssistant({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [readable, setReadable] = useState("");
  const [saving, setSaving] = useState(false);

  return (
    <>
      <div className="main-head">
        <div>
          <h2>New assistant</h2>
          <div className="sub">
            Each assistant is a focused context with its own instructions and its own
            discussions.
          </div>
        </div>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <section className="pane">
        <div className="form">
          <div className="field">
            <label>Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Renewals Analyst"
            />
          </div>
          <div className="field">
            <label>Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this assistant is for — shown in the rail"
            />
          </div>
          <div className="field">
            <label>Instructions</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={
                "How it should work. Be specific about what to read before answering,\nwhat to persist, and what it should not do."
              }
            />
          </div>
          <div className="field">
            <label>Read-only references (optional, one path per line)</label>
            <textarea
              style={{ minHeight: 72 }}
              value={readable}
              onChange={(e) => setReadable(e.target.value)}
              placeholder={"/Users/you/Notes"}
            />
            <div className="tools" style={{ marginTop: 6, lineHeight: 1.6 }}>
              Directories this assistant may <b>read</b>. It always gets its own
              private writable directory — leave this blank and it sees nothing
              else.
            </div>
          </div>
          <button
            className="btn btn-accent"
            disabled={!name.trim() || saving}
            onClick={async () => {
              setSaving(true);
              const r = await fetch("/api/assistants", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  name,
                  description,
                  systemPrompt,
                  readableDirs: readable
                    .split("\n")
                    .map((x) => x.trim())
                    .filter(Boolean),
                }),
              });
              const a: Assistant = await r.json();
              onCreated(a.id);
            }}
          >
            Create assistant
          </button>
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */

function Pulse({
  assistantId,
  onSwept,
}: {
  assistantId: string;
  onSwept: () => void;
}) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [latest, setLatest] = useState<Sweep | null>(null);
  const [thresholds, setThresholds] = useState({
    agingAfter: 7,
    staleAfter: 14,
    coldAfter: 30,
  });
  const [sweeping, setSweeping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFresh, setShowFresh] = useState(false);

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/pulse?assistantId=${assistantId}`, {
      cache: "no-store",
    });
    const d = await r.json();
    setScan(d.scan ?? null);
    setLatest(d.latest ?? null);
    if (d.thresholds) setThresholds(d.thresholds);
  }, [assistantId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function sweep() {
    setSweeping(true);
    setError(null);
    try {
      const r = await fetch("/api/pulse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assistantId }),
      });
      const d = await r.json();
      setScan(d.scan ?? null);
      setLatest(d.latest ?? null);
      setError(d.error ?? d.skipped ?? null);
      onSwept();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sweep failed.");
    } finally {
      setSweeping(false);
    }
  }

  const c = scan?.counts;
  const groups: Bucket[] = ["cold", "stale", "aging", "fresh"];

  return (
    <div className="p-grid">
      <section className="pane">
        <div className="pane-head">
          <h3>Commitments</h3>
          <button
            className="btn btn-sm btn-accent"
            disabled={sweeping}
            onClick={() => void sweep()}
          >
            {sweeping ? "Sweeping…" : "Run sweep"}
          </button>
        </div>

        <div className="pane-body pad">
          {c && c.open > 0 && (
            <div className="p-chips">
              {c.overdue > 0 && (
                <span className="p-chip overdue">{c.overdue} overdue</span>
              )}
              {groups.map((b) =>
                c[b] > 0 ? (
                  <span key={b} className={`p-chip ${b}`}>
                    {c[b]} {BUCKET_LABEL[b].toLowerCase()}
                  </span>
                ) : null,
              )}
              <span className="tools">
                quiet ≥{thresholds.agingAfter}d aging · ≥{thresholds.staleAfter}d
                stale · ≥{thresholds.coldAfter}d cold
              </span>
            </div>
          )}

          {scan && scan.open.length === 0 && (
            <div className="empty">
              <p style={{ marginTop: 0 }}>
                No open commitments found in {scan.files} markdown file
                {scan.files === 1 ? "" : "s"}.
              </p>
              <p>Write them as task lines and this fills itself in:</p>
              <pre className="p-convention">{CONVENTION}</pre>
              <p>
                Only the text is required. <code>moved:</code> is what makes
                staleness exact — without it the file&apos;s modified time is used
                instead and the item is marked <i>inferred</i>.
              </p>
            </div>
          )}

          {scan &&
            groups.map((bucket) => {
              const items = scan.open.filter((x) => x.bucket === bucket);
              if (items.length === 0) return null;
              if (bucket === "fresh" && !showFresh) {
                return (
                  <button
                    key={bucket}
                    className="linky p-showfresh"
                    onClick={() => setShowFresh(true)}
                  >
                    Show {items.length} fresh item
                    {items.length === 1 ? "" : "s"}
                  </button>
                );
              }
              return (
                <div key={bucket} className="p-group">
                  <div className={`p-group-head ${bucket}`}>
                    {BUCKET_LABEL[bucket]}
                    <span className="p-group-n">{items.length}</span>
                  </div>
                  {items.map((x) => (
                    <div className="c-row" key={`${x.file}:${x.line}`}>
                      <div className="c-text">{x.text}</div>
                      <div className="c-meta">
                        {x.daysOverdue > 0 && (
                          <span className="c-pill overdue">
                            overdue {x.daysOverdue}d
                          </span>
                        )}
                        <span className={`c-pill ${x.bucket}`}>
                          quiet {x.daysSince}d
                        </span>
                        {x.owner && <span className="c-owner">@{x.owner}</span>}
                        {x.blockedBy && (
                          <span className="c-blocked">
                            blocked&nbsp;on {x.blockedBy}
                          </span>
                        )}
                        {x.due && <span>due {x.due}</span>}
                        <span className="c-src">
                          {x.file}:{x.line}
                        </span>
                        {x.movedInferred && (
                          <span
                            className="c-inferred"
                            title={`No moved: stamp — dated ${x.lastMoved} from the file's modified time, which changes when anything in the file changes.`}
                          >
                            inferred
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}

          {scan && scan.uncovered.length > 0 && scan.open.length > 0 && (
            <div className="p-uncovered">
              No commitments in: {scan.uncovered.join(" · ")}
            </div>
          )}
        </div>
      </section>

      <section className="pane">
        <div className="pane-head">
          <h3>Digest</h3>
          {latest && <span className="tools">{day(latest.createdAt)}</span>}
        </div>
        <div className="pane-body pad">
          {error && <div className="p-error">{error}</div>}

          {!latest && !error && (
            <div className="empty">
              The scan on the left is deterministic — dates and day counts come
              straight off disk. A sweep hands that scan to the assistant, which
              decides what actually needs a nudge and why.
              <br />
              <br />
              Nothing has been swept yet.
            </div>
          )}

          {latest && (
            <>
              <div className="body">
                <Markdown>{latest.digest}</Markdown>
              </div>
              {latest.costUsd != null && (
                <div
                  className="cost"
                  title="Not charged — you're on a subscription. This is what the sweep would have cost at API rates."
                >
                  ≈ ${latest.costUsd.toFixed(4)} at API rates · not billed
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Knowledge({ assistantId }: { assistantId: string }) {
  const [root, setRoot] = useState("");
  const [readable, setReadable] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/knowledge?assistantId=${assistantId}`, {
      cache: "no-store",
    });
    const d = await r.json();
    setRoot(d.root ?? "");
    setReadable(d.readable ?? []);
    setFiles(d.files ?? []);
  }, [assistantId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function open(f: string) {
    const r = await fetch(
      `/api/knowledge?assistantId=${assistantId}&file=${encodeURIComponent(f)}`,
      { cache: "no-store" },
    );
    const d = await r.json();
    setFile(f);
    setContent(d.content ?? d.error ?? "");
    setDirty(false);
  }

  return (
    <div className="k-grid">
      <section className="pane">
        <div className="pane-head">
          <h3>Knowledge</h3>
          <span className="tools">{files.length}</span>
        </div>
        <div className="pane-body">
          <div className="scope">
            <div className="scope-l">Writable — this assistant only</div>
            <div className="scope-p">{root}</div>
            {readable.length > 0 && (
              <>
                <div className="scope-l" style={{ marginTop: 9 }}>
                  Read-only references
                </div>
                {readable.map((d) => (
                  <div className="scope-p ro" key={d}>
                    {d}
                  </div>
                ))}
              </>
            )}
          </div>
          {files.map((f) => (
            <button
              key={f}
              className={`k-file ${f === file ? "active" : ""}`}
              onClick={() => void open(f)}
            >
              {f}
            </button>
          ))}
          {files.length === 0 && (
            <div className="empty">
              Nothing here yet. This assistant writes its own knowledge in
              Authoring mode.
            </div>
          )}
        </div>
      </section>

      <section className="pane">
        <div className="pane-head">
          <h3 style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 600 }}>
            {file ?? "Select a file"}
          </h3>
          {file && (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn btn-sm btn-danger"
                onClick={async () => {
                  if (
                    !confirm(
                      `Delete "${file}"?\n\nThis removes the file from this assistant's own directory only:\n${root}\n\nNo other assistant and no directory outside it is touched.`,
                    )
                  )
                    return;
                  await fetch(
                    `/api/knowledge?assistantId=${assistantId}&file=${encodeURIComponent(file)}`,
                    { method: "DELETE" },
                  );
                  setFile(null);
                  setContent("");
                  setDirty(false);
                  await refresh();
                }}
              >
                Delete
              </button>
              <button
                className="btn btn-sm btn-accent"
                disabled={!dirty || saving}
                onClick={async () => {
                  setSaving(true);
                  await fetch("/api/knowledge", {
                    method: "PUT",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ assistantId, file, content }),
                  });
                  setDirty(false);
                  setSaving(false);
                }}
              >
                {saving ? "Saving…" : dirty ? "Save" : "Saved"}
              </button>
            </div>
          )}
        </div>
        {file ? (
          <textarea
            className="k-editor"
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setDirty(true);
            }}
          />
        ) : (
          <div className="empty" style={{ padding: "22px" }}>
            Files the assistant can read and write. Pick one to view or edit.
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface Health {
  installed: boolean;
  version?: string | null;
  loggedIn: boolean;
  authMethod?: string | null;
  account?: string | null;
  plan?: string | null;
  billed?: boolean;
  apiKeyPresent?: boolean;
  remedy?: string | null;
}

/**
 * Preflight for the CLI, and sign-in when it isn't authenticated yet.
 *
 * Signing in here does NOT make this app hold credentials. `claude auth login`
 * does the OAuth exchange itself and writes the result to the Keychain; we
 * start it, show the link it prints, and pass back the one-time authorization
 * code. Tokens never reach this app, and every turn afterwards runs on
 * whichever account the person signed in with — theirs, not the author's.
 */
function ClaudeStatus() {
  const [h, setH] = useState<Health | null>(null);
  const [checking, setChecking] = useState(true);
  const [login, setLogin] = useState<{ id: string; url: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setH(await r.json());
    } catch {
      setH(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  };

  const startLogin = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { ok: good, data } = await post({ action: "start" });
      if (good && data.url) {
        setLogin({ id: data.id, url: data.url });
        // The CLI opens this itself, but only on the machine running the
        // server. Same machine here — belt and braces if that fails.
        window.open(data.url, "_blank", "noopener");
      } else {
        setErr(data.error ?? "Could not start sign-in.");
      }
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    if (!login || !code.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const { ok: good, data } = await post({
        action: "code",
        id: login.id,
        code: code.trim(),
      });
      if (good) {
        setLogin(null);
        setCode("");
        await check();
      } else {
        setErr(data.error ?? "Sign-in failed.");
        // A dropped session can't be resumed — send them back to the button.
        if (data.error && /no longer open/i.test(data.error)) setLogin(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const cancelLogin = async () => {
    if (login) await post({ action: "cancel", id: login.id });
    setLogin(null);
    setCode("");
    setErr(null);
  };

  const signOut = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { ok: good, data } = await post({ action: "logout" });
      if (!good) setErr(data.error ?? "Sign-out failed.");
      await check();
    } finally {
      setBusy(false);
    }
  };

  const ok = h?.installed && h?.loggedIn;
  const state = checking
    ? { cls: "checking", label: "Checking…" }
    : !h
      ? { cls: "bad", label: "Check failed" }
      : !h.installed
        ? { cls: "bad", label: "Not installed" }
        : !h.loggedIn
          ? { cls: "bad", label: "Not signed in" }
          : h.billed
            ? { cls: "warn", label: "Signed in — API billing" }
            : { cls: "ok", label: "Signed in" };

  return (
    <div className="field">
      <label>Claude Code CLI</label>
      <div className={`cli-status ${state.cls}`}>
        <div className="cli-row">
          <span className="dot" />
          <b>{state.label}</b>
          <button className="btn btn-sm" onClick={check} disabled={checking}>
            Re-check
          </button>
        </div>

        {ok && (
          <table className="cli-facts">
            <tbody>
              <tr>
                <td>Account</td>
                <td>{h?.account ?? "—"}</td>
              </tr>
              <tr>
                <td>Plan</td>
                <td>{h?.plan ?? "—"}</td>
              </tr>
              <tr>
                <td>Auth method</td>
                <td>{h?.authMethod ?? "—"}</td>
              </tr>
              <tr>
                <td>Version</td>
                <td>{h?.version ?? "—"}</td>
              </tr>
            </tbody>
          </table>
        )}

        {/* Not installed is the one thing sign-in cannot fix. */}
        {h && !h.installed && h.remedy && (
          <pre className="cli-remedy">{h.remedy}</pre>
        )}

        {h?.installed && !h.loggedIn && !login && (
          <div className="cli-auth">
            <p className="cli-note">
              Sign in with your own Anthropic account. Claude Code performs the
              sign-in and stores it in your Keychain — this app never sees your
              password or tokens, and every turn afterwards runs on your
              subscription.
            </p>
            <button className="btn btn-sm" disabled={busy} onClick={() => void startLogin()}>
              {busy ? "Starting…" : "Sign in to Claude"}
            </button>
          </div>
        )}

        {login && (
          <div className="cli-auth">
            <p className="cli-note">
              A browser tab should have opened. Approve the request, copy the
              code Anthropic gives you, and paste it here.
            </p>
            <p className="cli-note">
              Didn&rsquo;t open?{" "}
              <a href={login.url} target="_blank" rel="noreferrer noopener">
                Open the sign-in page
              </a>
              .
            </p>
            <div className="tg-input">
              <input
                value={code}
                placeholder="Paste the code"
                autoFocus
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitCode();
                }}
              />
              <button
                className="btn btn-sm"
                disabled={busy || !code.trim()}
                onClick={() => void submitCode()}
              >
                {busy ? "Checking…" : "Finish"}
              </button>
            </div>
            <button className="btn btn-sm" disabled={busy} onClick={() => void cancelLogin()}>
              Cancel
            </button>
          </div>
        )}

        {err && <p className="cli-err">{err}</p>}

        {ok && h?.billed && (
          <p className="cli-note">
            {h.apiKeyPresent ? (
              <>
                <b>ANTHROPIC_API_KEY is set</b> in the shell running this server,
                so turns are billed per token instead of counting against your
                subscription. Unset it and restart to go back.
              </>
            ) : (
              <>
                This session is not on first-party subscription auth, so turns may
                be billed per token.
              </>
            )}
          </p>
        )}

        {ok && !h?.billed && (
          <p className="cli-note">
            Running on your subscription — nothing is billed per token.
            Credentials stay in the macOS Keychain; this app never reads them.
          </p>
        )}

        {ok && (
          <button className="btn btn-sm" disabled={busy} onClick={() => void signOut()}>
            Sign out
          </button>
        )}
      </div>
    </div>
  );
}

interface TelegramStatus {
  configured: boolean;
  invalid?: boolean;
  bot?: string;
  allowedIds?: string;
  running?: boolean;
  tokenTail?: string;
  hint?: string;
  error?: string;
}

/**
 * Telegram configuration. The token is written straight to the Keychain and
 * never read back — this panel can replace it but not reveal it.
 */
function TelegramSettings() {
  const [st, setSt] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState("");
  const [ids, setIds] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/telegram", { cache: "no-store" });
      const d = await r.json();
      setSt(d);
      setIds(d.allowedIds ?? "");
    } catch {
      setSt(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (payload: Record<string, unknown>) => {
      setBusy(true);
      setMsg(null);
      try {
        const r = await fetch("/api/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        setMsg({ text: d.error ?? d.message ?? "Saved.", bad: !r.ok });
        if (r.ok) {
          setToken("");
          await load();
        }
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return (
    <div className="field">
      <label>Telegram</label>
      <div className="tg">
        <div className="tg-row">
          <span className={`dot ${st?.configured && !st.invalid ? "ok" : "off"}`} />
          <b>
            {!st
              ? "Checking…"
              : st.invalid
                ? "Token rejected"
                : st.configured
                  ? st.bot
                  : "Not configured"}
          </b>
          {st?.configured && (
            <span className="tg-run">
              {st.running ? "relay running" : "relay not running"}
            </span>
          )}
        </div>

        {!st?.configured && (
          <p className="tg-hint">
            {st?.hint ??
              "Create a bot with @BotFather in Telegram, then paste the token it gives you."}
          </p>
        )}

        <div className="tg-field">
          <label>Bot token</label>
          <div className="tg-input">
            <input
              type="password"
              value={token}
              placeholder={
                st?.configured ? `stored, ending ${st.tokenTail}` : "123456:ABC-..."
              }
              onChange={(e) => setToken(e.target.value)}
            />
            <button
              className="btn btn-sm"
              disabled={busy || !token.trim()}
              onClick={() => void save({ token: token.trim() })}
            >
              {busy ? "Checking…" : st?.configured ? "Replace" : "Save"}
            </button>
          </div>
          <p className="tg-note">
            Stored in your macOS Keychain, never in a file, and never shown again.
          </p>
        </div>

        <div className="tg-field">
          <label>Allowed Telegram user ids</label>
          <div className="tg-input">
            <input
              value={ids}
              placeholder="e.g. 123456789"
              onChange={(e) => setIds(e.target.value)}
            />
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void save({ allowedIds: ids })}
            >
              Save
            </button>
          </div>
          <p className="tg-note">
            Anyone can message a bot, so only these ids are answered. Message the
            bot once and its log prints the id that was refused. Comma-separate
            several.
          </p>
        </div>

        {msg && <p className={`tg-msg${msg.bad ? " bad" : ""}`}>{msg.text}</p>}

        {st?.configured && (
          <button
            className="btn btn-sm btn-danger"
            disabled={busy}
            onClick={() => void save({ action: "clear" })}
          >
            Remove configuration
          </button>
        )}

        <p className="tg-note">
          Start the relay with <b>npm run bot</b>. Changes here take effect when
          it next starts.
        </p>
      </div>
    </div>
  );
}

function Settings({
  settings,
}: {
  settings: { knowledgeDirs: string[]; knowledgeRoot: string };
}) {
  return (
    <section className="pane">
      <div className="pane-head">
        <h3>Settings</h3>
      </div>
      <div className="form">
        <ClaudeStatus />
        <TelegramSettings />
        <div className="field">
          <label>Knowledge root (browsed in the Knowledge tab)</label>
          <input readOnly value={settings.knowledgeRoot} />
        </div>
        <div className="field">
          <label>Readable directories (passed to the CLI as --add-dir)</label>
          <input readOnly value={settings.knowledgeDirs.join("  ·  ")} />
        </div>
        <div className="tools" style={{ lineHeight: 1.7 }}>
          Edit these in <b>data/store.json</b>, then restart the dev server.
          <br />
          Runs on your Claude subscription via the <b>claude</b> CLI — no API key,
          no per-token billing. The figure under each reply is what the turn would
          have cost at API rates; you are not charged it. Usage counts against your
          subscription rate limits instead.
          <br />
          <br />⚠️ If <b>ANTHROPIC_API_KEY</b> is ever exported in the shell that
          runs the dev server, the CLI switches to API billing and those amounts
          become real.
        </div>
      </div>
    </section>
  );
}
