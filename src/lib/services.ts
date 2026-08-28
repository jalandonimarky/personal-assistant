/**
 * External services an assistant may reach, granted per turn.
 *
 * These are MCP servers already connected to Claude Code, so there is no OAuth
 * or token handling here — this module decides only *which tools are unlocked
 * for a given turn*.
 *
 * The gate is `--allowedTools`, not an instruction. A tool absent from that
 * list cannot be called, so an ungranted service is unreachable at the process
 * level rather than merely discouraged.
 *
 * TWO LEVELS, least privilege by default:
 *
 *   read   — retrieval only. Always available.
 *   write  — additionally unlocks a NARROW set of reversible actions, and only
 *            in Authoring mode.
 *
 * Two rules hold the line, and both are enforced in code rather than asked for:
 *
 *   1. Brainstorming and Critique can never write. Their modes carry no Write
 *      tool, and toolsFor() drops write-level service tools for them outright,
 *      so a stale or forged grant cannot elevate a read-only mode.
 *
 *   2. Irreversible and outward-facing actions are not offered at any level.
 *      Sending mail, deleting, merging, deploying — these have no entry below.
 *      `claude -p` is non-interactive and Authoring runs `acceptEdits`, so an
 *      allowed tool fires with no confirmation step and no undo. A draft a
 *      human sends is a different risk from a send a model performs.
 */

export type Level = "read" | "write";

/** A grant is a service plus the level asked for. */
export interface Grant {
  id: string;
  level: Level;
}

export type AuthKind =
  /**
   * A claude.ai connector, synced down from the account rather than configured
   * here. Two different failures hide behind that: the connector may not be
   * enabled on the account at all (fix it on the web), or it may be enabled and
   * simply not authorised on this machine (`claude mcp login` fixes that, and
   * the app can drive it). Telling those apart is the whole point of `setupUrl`.
   */
  | { kind: "account"; setupUrl: string }
  /** Local tooling: needs registering with the CLI, but holds no credential. */
  | { kind: "none" }
  | { kind: "oauth" }
  | { kind: "token"; url: string; help: string };

export interface Service {
  id: string;
  label: string;
  blurb: string;
  /** Name this server appears under in `claude mcp list`. */
  mcpName: string;
  /** Our own server, relative to the repo root. Absent for account connectors. */
  script?: string;
  auth: AuthKind;
  /** Env the server cannot start without. */
  requiredEnv?: string[];

  /** Retrieval tools. Always unlocked when the service is granted. */
  read: string[];
  /** Reversible actions. Authoring only. Absent means no write level exists. */
  write?: string[];

  grants: string[];
  withheld: string[];
  /** What the write level adds, in plain terms. */
  writeGrants?: string[];
  /** Why no write level is offered, when there isn't one. */
  writeNote?: string;
  /** What signing in actually asks the provider for. Shown before consent. */
  authNote?: string;
  /** Where the one-time setup is written down. Not derivable: Gmail and Drive share one. */
  setupDoc?: string;
  /**
   * A provider-level credential that must exist before anyone can sign in —
   * Google's OAuth client, for instance. Kept in the Keychain and entered in
   * the panel rather than read from the environment: this app usually runs as
   * a launchd agent, which has no shell to export a variable into.
   */
  /**
   * Only shown once its clientConfig is filled in. Keeps the "bring your own
   * OAuth client" variants out of the way of the zero-setup path.
   */
  advanced?: boolean;
  clientConfig?: {
    idService: string;
    idLabel: string;
    /** One line shown while it is missing. An OAuth client and an app password
     *  are not the same thing, and the panel should not call them the same. */
    prompt?: string;
    secretService?: string;
    secretLabel?: string;
    /** Where to create it. */
    url: string;
    help: string;
  };
}

/**
 * One OAuth client serves both Google servers, so the descriptor is shared.
 * Entering it once in the panel configures Gmail and Drive together.
 */
const GOOGLE_CLIENT_CONFIG = {
  idService: "google-oauth-client-id",
  idLabel: "Client ID",
  prompt: "Add an OAuth client before signing in.",
  secretService: "google-oauth-client-secret",
  secretLabel: "Client secret (only if your client type issued one)",
  url: "https://console.cloud.google.com/apis/credentials",
  help:
    "Create an OAuth client (type: Desktop app) in a Google Cloud project with " +
    "the Gmail and Drive APIs enabled, then paste it here. Full steps are in " +
    "mcp/google/README.md.",
};

export const SERVICES: Service[] = [
  {
    id: "gmail",
    label: "Gmail",
    blurb: "Read and search your mail",
    mcpName: "claude.ai Gmail",
    auth: { kind: "account", setupUrl: "https://claude.ai/settings/connectors" },
    authNote:
      "Comes from your Claude account — nothing to create, no client ID. Enable it once at claude.ai and it follows you to any machine you sign in on.",
    read: [
      "mcp__claude_ai_Gmail__search_threads",
      "mcp__claude_ai_Gmail__get_thread",
      "mcp__claude_ai_Gmail__get_message",
      "mcp__claude_ai_Gmail__list_labels",
      "mcp__claude_ai_Gmail__list_drafts",
    ],
    write: [
      "mcp__claude_ai_Gmail__create_draft",
      "mcp__claude_ai_Gmail__update_draft",
      "mcp__claude_ai_Gmail__label_message",
      "mcp__claude_ai_Gmail__label_thread",
      // Creating and renaming a label are reversible and touch no mail.
      // delete_label is not offered: it strips the label off every message
      // that carries it, and nothing here would ask first.
      "mcp__claude_ai_Gmail__create_label",
      "mcp__claude_ai_Gmail__update_label",
    ],
    grants: [
      "Search your mailbox and read the messages it finds",
      "Read a specific thread or message in full",
      "List your labels and existing drafts",
    ],
    writeGrants: [
      "Draft a reply for you to review and send yourself",
      "Edit a draft it created",
      "Create and rename labels, and apply them to mail",
    ],
    withheld: [
      "Send, reply to, or forward anything",
      "Trash messages or mark them as spam",
      "Delete a label",
    ],
  },
  {
    id: "gmail-imap",
    label: "Gmail (app password)",
    blurb: "Read and search your mail with no Google Cloud project",
    mcpName: "gmail-imap",
    script: "mcp/gmail-imap/src/index.mjs",
    auth: { kind: "none" },
    setupDoc: "mcp/gmail-imap/README.md",
    authNote:
      "No app to create and no client ID. Generate an app password in your Google account and paste it here.",
    clientConfig: {
      idService: "gmail-imap-user",
      idLabel: "Your Gmail address",
      prompt: "Add your address and an app password.",
      secretService: "gmail-imap-app-password",
      secretLabel: "16-character app password",
      url: "https://myaccount.google.com/apppasswords",
      help:
        "Requires 2-Step Verification on the account. Google Account → Security → " +
        "App passwords, generate one, and paste it with your address. Steps are in " +
        "mcp/gmail-imap/README.md.",
    },
    read: [
      "mcp__gmail_imap__gmail_search",
      "mcp__gmail_imap__gmail_get_message",
      "mcp__gmail_imap__gmail_list_mailboxes",
    ],
    grants: [
      "Search your mailbox with Gmail's own query syntax",
      "Read any message it finds, in full",
      "List your mailboxes and labels",
    ],
    withheld: [
      "Send, reply to, or forward anything",
      "Delete, flag, or move mail",
      "Mark anything as read",
    ],
    // Not a policy choice that could be reversed by a flag: the mailbox is
    // opened with EXAMINE rather than SELECT, and the client implements no
    // APPEND, STORE or EXPUNGE. There is no write path to offer.
    writeNote:
      "Read-only by construction — the connection cannot write, so there is no write level. Use the connector or an OAuth client for drafts and labels.",
  },
  {
    id: "gmail-own",
    label: "Gmail (own Google client)",
    blurb: "Read and search your mail, independent of your Claude account",
    mcpName: "gmail",
    script: "mcp/gmail/src/index.mjs",
    auth: { kind: "oauth" },
    setupDoc: "mcp/google/README.md",
    clientConfig: GOOGLE_CLIENT_CONFIG,
    advanced: true,
    read: [
      "mcp__gmail__gmail_search",
      "mcp__gmail__gmail_get_thread",
      "mcp__gmail__gmail_get_message",
      "mcp__gmail__gmail_list_labels",
      "mcp__gmail__gmail_list_drafts",
    ],
    // Drafts and labels only. Both are reversible and both leave a human
    // between the model and the recipient. send/reply/forward/trash/spam are
    // deliberately absent: a sent mail cannot be recalled, and nothing here
    // would ask before sending it.
    write: [
      "mcp__gmail__gmail_create_draft",
      "mcp__gmail__gmail_update_draft",
      "mcp__gmail__gmail_modify_labels",
      "mcp__gmail__gmail_create_label",
      "mcp__gmail__gmail_update_label",
    ],
    grants: [
      "Search your mailbox and read the messages it finds",
      "Read a specific thread or message in full",
      "List your labels and existing drafts",
    ],
    writeGrants: [
      "Draft a reply for you to review and send yourself",
      "Edit a draft it created",
      "Create and rename labels, and apply them to mail",
    ],
    withheld: [
      "Send, reply to, or forward anything",
      "Trash messages or mark them as spam",
      "Delete a label",
    ],
    // Not merely unlisted: gmail.send is never requested at sign-in, so a send
    // is un-grantable rather than just withheld.
    authNote: "Signs in as you. Asks only for read, drafts and labels — never send.",
  },
  {
    id: "googledrive",
    label: "Google Drive",
    blurb: "Search and read your Drive files",
    mcpName: "claude.ai Google Drive",
    auth: { kind: "account", setupUrl: "https://claude.ai/settings/connectors" },
    authNote:
      "Comes from your Claude account — nothing to create, no client ID. Enable it once at claude.ai and it follows you to any machine you sign in on.",
    read: [
      "mcp__claude_ai_Google_Drive__search_files",
      "mcp__claude_ai_Google_Drive__read_file_content",
      "mcp__claude_ai_Google_Drive__get_file_metadata",
      "mcp__claude_ai_Google_Drive__list_recent_files",
      "mcp__claude_ai_Google_Drive__download_file_content",
    ],
    write: [
      "mcp__claude_ai_Google_Drive__create_file",
      "mcp__claude_ai_Google_Drive__update_file",
      "mcp__claude_ai_Google_Drive__copy_file",
    ],
    grants: [
      "Search your Drive and read file contents, including native Docs and Sheets",
      "List recent files and read their metadata",
      "Download a file to work from",
    ],
    writeGrants: [
      "Create a new file or folder in Drive",
      "Update the contents of an existing file",
      "Copy a file",
    ],
    withheld: [
      "Share files or change who can access them",
      "Trash or permanently delete anything",
      "Change permissions on existing files",
    ],
  },
  {
    id: "googledrive-own",
    label: "Google Drive (own Google client)",
    blurb: "Search and read your Drive files, independent of your Claude account",
    mcpName: "drive",
    script: "mcp/drive/src/index.mjs",
    auth: { kind: "oauth" },
    setupDoc: "mcp/google/README.md",
    clientConfig: GOOGLE_CLIENT_CONFIG,
    advanced: true,
    // The API reads native Google Docs and Sheets as actual content. A synced
    // local folder cannot — Google-native files sync as .gdoc/.gsheet stubs
    // holding a document id, not the document.
    read: [
      "mcp__drive__drive_search",
      "mcp__drive__drive_read_file",
      "mcp__drive__drive_get_metadata",
      "mcp__drive__drive_list_recent",
    ],
    // Creating and editing are recoverable — Drive keeps version history and a
    // trash. Sharing and trashing are not offered: sharing changes who can see
    // your data and cannot be un-seen, and nothing here would ask first.
    write: [
      "mcp__drive__drive_create_file",
      "mcp__drive__drive_update_file",
      "mcp__drive__drive_copy_file",
    ],
    grants: [
      "Search your Drive and read file contents, including native Docs and Sheets",
      "List recent files and read their metadata",
      "Download a file to work from",
    ],
    writeGrants: [
      "Create a new file in Drive",
      "Update a file it created itself",
      "Copy a file",
    ],
    withheld: [
      "Share files or change who can access them",
      "Trash or permanently delete anything",
      "Change permissions on existing files",
      "Overwrite a file it did not create",
    ],
    authNote:
      "Signs in as you. Reading covers your whole Drive; writing is scoped to files this assistant created.",
  },
  {
    id: "outlook",
    label: "Outlook",
    blurb: "Read and search your work mail",
    mcpName: "outlook",
    script: "mcp/outlook/src/index.mjs",
    auth: { kind: "oauth" },
    requiredEnv: ["OUTLOOK_TENANT_ID", "OUTLOOK_CLIENT_ID"],
    read: [
      "mcp__outlook__outlook_search_messages",
      "mcp__outlook__outlook_get_message",
      "mcp__outlook__outlook_list_folders",
    ],
    grants: [
      "Search your mailbox and read the messages it finds",
      "Read a specific message in full",
      "List your mail folders",
    ],
    withheld: [
      "Send, reply to, or forward anything",
      "Create or edit drafts",
      "Move, delete, or flag messages",
    ],
    // Not a toggle. The app registration requests Mail.Read only; anything
    // that writes needs Mail.ReadWrite added and fresh tenant admin consent.
    writeNote:
      "Read-only until IT adds Mail.ReadWrite to the app registration and grants admin consent.",
  },
  {
    id: "github",
    label: "GitHub",
    blurb: "Read repos, issues, PRs, commits and files",
    mcpName: "github",
    script: "mcp/github/src/index.mjs",
    auth: {
      kind: "token",
      url: "https://github.com/settings/personal-access-tokens",
      help: "Fine-grained token. Read-only unless you intend to use the write level.",
    },
    read: [
      "mcp__github__github_search_repos",
      "mcp__github__github_list_repos",
      "mcp__github__github_list_issues",
      "mcp__github__github_get_issue",
      "mcp__github__github_list_commits",
      "mcp__github__github_read_file",
      "mcp__github__github_pr_status",
      "mcp__github__github_list_pull_requests",
    ],
    // Commenting is additive and visibly attributed. Pushing, merging, closing
    // and releasing are not offered — they change what other people depend on.
    write: ["mcp__github__github_comment_on_issue"],
    grants: [
      "List and search repositories you can access",
      "Read issues, pull requests, and their discussion",
      "Read commit history and file contents",
      "Check PR status — mergeability, CI checks, reviews, changed files",
    ],
    writeGrants: ["Post a comment on an issue or pull request"],
    withheld: [
      "Push commits or open pull requests",
      "Merge, close, or reopen anything",
      "Change settings, secrets, or collaborators",
    ],
  },
  {
    id: "vercel",
    label: "Vercel",
    blurb: "Read projects, deployments and build logs",
    mcpName: "vercel",
    script: "mcp/vercel/src/index.mjs",
    auth: {
      kind: "token",
      url: "https://vercel.com/account/tokens",
      help: "Scope it to the narrowest team that covers what you need.",
    },
    read: [
      "mcp__vercel__vercel_list_projects",
      "mcp__vercel__vercel_list_deployments",
      "mcp__vercel__vercel_get_deployment",
      "mcp__vercel__vercel_deployment_events",
      "mcp__vercel__vercel_list_domains",
    ],
    grants: [
      "List projects, deployments, and domains",
      "Read a deployment's state, commit, and URLs",
      "Read build logs to diagnose a failed deploy",
    ],
    withheld: [
      "Create, promote, roll back, or delete deployments",
      "Read environment variables or secrets",
      "Change project settings or domains",
    ],
    // Every write Vercel offers lands on production. There is no reversible
    // middle ground worth the risk of an unconfirmed call.
    writeNote:
      "No write level. Every action Vercel exposes affects a live deployment.",
  },
];

export const getService = (id: string): Service | null =>
  SERVICES.find((s) => s.id === id) ?? null;

/** Does this service offer a write level at all? */
export const hasWrite = (s: Service): boolean => Boolean(s.write?.length);

/**
 * Resolve client-supplied grants to tool names.
 *
 * Grants arrive over HTTP, so they are untrusted: unknown ids are dropped and
 * nothing the client sends reaches `--allowedTools` verbatim — only tool names
 * from the table above.
 *
 * `modeCanWrite` is the second gate. Brainstorming and Critique pass false, so
 * a write grant from a stale tab, a replayed request, or a forged body silently
 * degrades to read instead of elevating a read-only mode.
 */
export function toolsFor(grants: unknown, modeCanWrite: boolean): string[] {
  if (!Array.isArray(grants)) return [];
  const out = new Set<string>();

  for (const g of grants) {
    // Accept a bare id as read, for older callers.
    const id = typeof g === "string" ? g : typeof g?.id === "string" ? g.id : null;
    const level: Level = typeof g === "object" && g?.level === "write" ? "write" : "read";
    const svc = id ? getService(id) : null;
    if (!svc) continue;

    svc.read.forEach((t) => out.add(t));
    if (level === "write" && modeCanWrite && svc.write) {
      svc.write.forEach((t) => out.add(t));
    }
  }
  return [...out];
}

/** What a turn was actually granted, after the mode gate. For the record. */
export function effectiveGrants(grants: unknown, modeCanWrite: boolean): Grant[] {
  if (!Array.isArray(grants)) return [];
  const out: Grant[] = [];
  for (const g of grants) {
    const id = typeof g === "string" ? g : typeof g?.id === "string" ? g.id : null;
    const asked: Level = typeof g === "object" && g?.level === "write" ? "write" : "read";
    const svc = id ? getService(id) : null;
    if (!svc) continue;
    const level: Level =
      asked === "write" && modeCanWrite && hasWrite(svc) ? "write" : "read";
    out.push({ id: svc.id, level });
  }
  return out;
}
