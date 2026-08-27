import { spawn } from "node:child_process";
import type { Mode } from "./modes";

export interface RunArgs {
  prompt: string;
  systemPrompt: string;
  /** Tone, appended last. See Assistant.voice. */
  voice?: string;
  mode: Mode;
  /** Existing CLI session to continue, or null to start a new one. */
  sessionId: string | null;
  /** New session id to claim when sessionId is null. */
  newSessionId: string;
  addDirs: string[];
  cwd: string;
  /** Where the reply will be displayed. Decides which formatting block applies. */
  channel?: "web" | "plain";
  /**
   * Extra MCP tool names unlocked for this turn only (see lib/services.ts).
   * Absent from --allowedTools means unreachable, not merely discouraged.
   */
  serviceTools?: string[];
}

export interface RunResult {
  text: string;
  questions: string[];
  sessionId: string;
  costUsd: number | null;
  isError: boolean;
}

/**
 * The chat panel renders GitHub-flavoured markdown, so structure is worth asking
 * for explicitly — otherwise replies arrive as prose with stray asterisks.
 */
const FORMATTING = [
  "",
  "---",
  "Your reply is rendered as GitHub-flavoured markdown, so use real structure:",
  "",
  "- **Comparisons, statuses, or anything with repeating fields → a markdown table.**",
  "  Never fake one with dashes, pipes-without-a-header-row, or aligned spaces.",
  "- `**bold**` for the thing that matters, `*italic*` for emphasis, `<u>underline</u>`",
  "  where you genuinely need it (markdown has no underline syntax).",
  "- `` `code` `` for file paths, field names, IDs, endpoints and commands.",
  "  Fenced blocks with a language for anything multi-line.",
  "- Real `-` lists and `##` headings — not bullets typed as `*` mid-paragraph.",
  "",
  "Do not write a markup symbol you don't intend to be rendered. If you want a",
  "literal asterisk or underscore, escape it. Match the structure to the content:",
  "a one-line answer is a sentence, not a table with one row.",
].join("\n");

/**
 * Telegram (and any other plain-text transport) renders nothing — `**bold**`
 * arrives with its asterisks and a table arrives as raw pipes. The default
 * block above would actively make replies worse there.
 */
const PLAIN = [
  "",
  "---",
  "Your reply is delivered as plain text on a phone. It is NOT rendered, so any",
  "markdown symbol you type will be visible as a symbol.",
  "",
  "- No tables, no headings, no bold, italic, backticks or fenced blocks.",
  "- Short paragraphs. A blank line between them.",
  "- A plain hyphen at the start of a line is fine for a short list.",
  "- Lead with the answer. Keep it to what would read well on a phone screen.",
].join("\n");

/**
 * Tells the assistant to park clarifying questions instead of blocking on them.
 * The block is stripped from the visible reply and surfaced in the Questions tab.
 */
const QUESTION_PROTOCOL = [
  "",
  "---",
  "If something is genuinely ambiguous, do NOT stop and ask. Answer with your best",
  "reading, then append a block at the very end of your reply:",
  "",
  "<questions>",
  "- the thing you'd have asked",
  "</questions>",
  "",
  "Only include questions whose answer would change what you produced. Omit the",
  "block entirely if there are none. Never mention the block itself in your prose.",
].join("\n");

function extractQuestions(raw: string): { text: string; questions: string[] } {
  const match = raw.match(/<questions>([\s\S]*?)<\/questions>/i);
  if (!match) return { text: raw.trim(), questions: [] };

  const questions = match[1]
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);

  const text = raw.replace(match[0], "").trim();
  return { text, questions };
}

export function runClaude(args: RunArgs): Promise<RunResult> {
  const {
    prompt,
    systemPrompt,
    voice,
    mode,
    sessionId,
    newSessionId,
    addDirs,
    cwd,
    channel = "web",
    serviceTools = [],
  } = args;

  const argv: string[] = [
    "-p",
    "--output-format",
    "json",
    "--model",
    mode.model,
    "--append-system-prompt",
    `${systemPrompt}\n\n${mode.instruction}${channel === "plain" ? PLAIN : FORMATTING}${QUESTION_PROTOCOL}` +
      (voice ? `\n\n---\nHOW YOU SOUND\n\n${voice}` : ""),
    "--allowedTools",
    ...mode.tools,
    ...serviceTools,
    "--permission-mode",
    mode.tools.includes("Write") ? "acceptEdits" : "default",
  ];

  for (const dir of addDirs) argv.push("--add-dir", dir);

  if (sessionId) argv.push("--resume", sessionId);
  else argv.push("--session-id", newSessionId);

  return new Promise((resolve, reject) => {
    // `next dev` can inherit a PATH without the user's npm global bin, which
    // makes claude fail with ENOENT. Extend it rather than relying on the shell
    // the server happened to be started from.
    const extraPath = [
      `${process.env.HOME}/.npm-global/bin`,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ].join(":");

    const child = spawn("claude", argv, {
      cwd,
      env: { ...process.env, PATH: `${extraPath}:${process.env.PATH ?? ""}` },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("error", (e) =>
      reject(new Error(`Could not run the \`claude\` CLI: ${e.message}`)),
    );

    child.on("close", (code) => {
      if (!out.trim()) {
        reject(
          new Error(
            `claude exited ${code} with no output.${err ? `\n${err.trim()}` : ""}`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(out);
        const { text, questions } = extractQuestions(
          String(parsed.result ?? ""),
        );
        resolve({
          text,
          questions,
          sessionId: parsed.session_id ?? sessionId ?? newSessionId,
          costUsd:
            typeof parsed.total_cost_usd === "number"
              ? parsed.total_cost_usd
              : null,
          isError: Boolean(parsed.is_error),
        });
      } catch {
        reject(new Error(`Unparseable output from claude:\n${out.slice(0, 600)}`));
      }
    });

    // Prompt goes over stdin so long messages can't blow the argv limit.
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
