#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serve, cli, notAuthenticated } from "../../lib/rpc.mjs";
import * as keychain from "../../lib/keychain.mjs";

const run = promisify(execFile);
const SERVICE = "github-mcp-token";
const API = "https://api.github.com";

/**
 * Read-only GitHub MCP server.
 *
 * Two auth paths, in order:
 *   1. A token stored in the Keychain (`--login`, read from stdin).
 *   2. Whatever `gh auth token` returns, if the CLI is signed in.
 *
 * (2) means zero setup on a machine that already uses `gh`. It is also the
 * weaker of the two: a `gh` token usually carries write scopes, so with it the
 * only thing preventing a write is this server's tool surface. A fine-grained
 * read-only PAT via (1) makes the *credential* incapable of writing, which is
 * the stronger guarantee. Prefer it for anything shared or unattended.
 */
async function token() {
  const stored = await keychain.get(SERVICE);
  if (stored) return stored;
  try {
    const { stdout } = await run("gh", ["auth", "token"], { timeout: 10_000 });
    const t = stdout.trim();
    if (t) return t;
  } catch {
    /* gh absent or signed out — fall through */
  }
  throw notAuthenticated(
    "Not signed in to GitHub. Either `gh auth login`, or store a read-only " +
      "fine-grained token: `pbpaste | node mcp/github/src/index.mjs --login`.",
  );
}

async function api(path, params) {
  const t = await token();
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${t}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "github-mcp",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Write path. Kept distinct from api() so the read helper cannot be made to
 * mutate anything by passing the wrong argument.
 */
async function apiPost(path, body) {
  const t = await token();
  const res = await fetch(API + path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${t}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "github-mcp",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

const TOOLS = [
  {
    name: "github_search_repos",
    description: "Search GitHub repositories. Returns name, description, language, stars.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "GitHub search syntax, e.g. 'user:me next.js'." },
        top: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "github_list_repos",
    description: "List repositories the signed-in user can access, most recently pushed first.",
    inputSchema: {
      type: "object",
      properties: { top: { type: "integer", minimum: 1, maximum: 100 } },
    },
  },
  {
    name: "github_list_issues",
    description:
      "List issues or pull requests on a repository. Set isPullRequest to filter to PRs.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name" },
        state: { type: "string", enum: ["open", "closed", "all"] },
        top: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_get_issue",
    description: "Read one issue or pull request in full, including its body.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name" },
        number: { type: "integer" },
      },
      required: ["repo", "number"],
    },
  },
  {
    name: "github_list_commits",
    description: "List recent commits on a repository branch.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name" },
        branch: { type: "string" },
        top: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_pr_status",
    description:
      "Status of one pull request: state, mergeability, review decision, CI " +
      "check conclusions, and the files it touches. Use for 'is this ready to merge'.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name" },
        number: { type: "integer" },
      },
      required: ["repo", "number"],
    },
  },
  {
    name: "github_list_pull_requests",
    description: "List pull requests on a repository with their state and branch.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name" },
        state: { type: "string", enum: ["open", "closed", "all"] },
        top: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_comment_on_issue",
    description:
      "Post a comment on an issue or pull request. Additive and attributed — " +
      "it cannot edit or delete anything that already exists.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name" },
        number: { type: "integer" },
        body: { type: "string", description: "Markdown comment body." },
      },
      required: ["repo", "number", "body"],
    },
  },
  {
    name: "github_read_file",
    description: "Read a file from a repository at a given ref.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name" },
        path: { type: "string" },
        ref: { type: "string", description: "Branch, tag, or SHA. Defaults to the default branch." },
      },
      required: ["repo", "path"],
    },
  },
];

const repoLine = (r) => ({
  fullName: r.full_name,
  description: r.description,
  language: r.language,
  stars: r.stargazers_count,
  private: r.private,
  pushedAt: r.pushed_at,
  url: r.html_url,
});

async function call(name, args = {}) {
  const top = Math.min(Math.max(Number(args.top) || 20, 1), 100);

  switch (name) {
    case "github_search_repos": {
      const d = await api("/search/repositories", { q: args.query, per_page: Math.min(top, 50) });
      return { total: d.total_count, repos: (d.items ?? []).map(repoLine) };
    }
    case "github_list_repos": {
      const d = await api("/user/repos", { per_page: top, sort: "pushed" });
      return { repos: d.map(repoLine) };
    }
    case "github_list_issues": {
      const d = await api(`/repos/${args.repo}/issues`, {
        state: args.state || "open",
        per_page: Math.min(top, 50),
      });
      return {
        issues: d.map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          isPullRequest: Boolean(i.pull_request),
          author: i.user?.login,
          comments: i.comments,
          updatedAt: i.updated_at,
          url: i.html_url,
        })),
      };
    }
    case "github_get_issue": {
      const i = await api(`/repos/${args.repo}/issues/${args.number}`);
      return {
        number: i.number,
        title: i.title,
        state: i.state,
        isPullRequest: Boolean(i.pull_request),
        author: i.user?.login,
        createdAt: i.created_at,
        updatedAt: i.updated_at,
        body: (i.body ?? "").slice(0, 20_000),
        url: i.html_url,
      };
    }
    case "github_list_commits": {
      const d = await api(`/repos/${args.repo}/commits`, {
        sha: args.branch,
        per_page: Math.min(top, 50),
      });
      return {
        commits: d.map((c) => ({
          sha: c.sha.slice(0, 8),
          message: (c.commit?.message ?? "").split("\n")[0],
          author: c.commit?.author?.name,
          date: c.commit?.author?.date,
        })),
      };
    }
    case "github_list_pull_requests": {
      const d = await api(`/repos/${args.repo}/pulls`, {
        state: args.state || "open",
        per_page: Math.min(top, 50),
      });
      return {
        pulls: d.map((p) => ({
          number: p.number,
          title: p.title,
          state: p.state,
          draft: p.draft,
          author: p.user?.login,
          head: p.head?.ref,
          base: p.base?.ref,
          updatedAt: p.updated_at,
          url: p.html_url,
        })),
      };
    }
    case "github_pr_status": {
      const pr = await api(`/repos/${args.repo}/pulls/${args.number}`);
      // Checks hang off the head commit, not the PR itself.
      const [checks, reviews, files] = await Promise.all([
        api(`/repos/${args.repo}/commits/${pr.head.sha}/check-runs`, { per_page: 30 }).catch(
          () => ({ check_runs: [] }),
        ),
        api(`/repos/${args.repo}/pulls/${args.number}/reviews`, { per_page: 30 }).catch(() => []),
        api(`/repos/${args.repo}/pulls/${args.number}/files`, { per_page: 100 }).catch(() => []),
      ]);
      return {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        draft: pr.draft,
        merged: pr.merged,
        // null means GitHub is still computing it — not the same as false.
        mergeable: pr.mergeable,
        mergeableState: pr.mergeable_state,
        head: pr.head?.ref,
        base: pr.base?.ref,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
        checks: (checks.check_runs ?? []).map((c) => ({
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
        })),
        reviews: (Array.isArray(reviews) ? reviews : []).map((r) => ({
          reviewer: r.user?.login,
          state: r.state,
        })),
        files: (Array.isArray(files) ? files : []).slice(0, 100).map((f) => ({
          path: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        })),
        url: pr.html_url,
      };
    }
    case "github_comment_on_issue": {
      if (!args.body?.trim()) throw new Error("body is required.");
      const c = await apiPost(`/repos/${args.repo}/issues/${args.number}/comments`, {
        body: String(args.body),
      });
      return { posted: true, url: c.html_url, id: c.id };
    }
    case "github_read_file": {
      const f = await api(
        `/repos/${args.repo}/contents/${args.path.split("/").map(encodeURIComponent).join("/")}`,
        { ref: args.ref },
      );
      if (Array.isArray(f)) {
        return { directory: true, entries: f.map((e) => ({ name: e.name, type: e.type })) };
      }
      if (f.encoding !== "base64") throw new Error(`Unsupported encoding: ${f.encoding}`);
      return {
        path: f.path,
        size: f.size,
        content: Buffer.from(f.content, "base64").toString("utf8").slice(0, 40_000),
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const arg = process.argv[2];
if (arg === "--login") {
  await cli(async () => {
    const t = await keychain.readSecret();
    if (!t) throw new Error("No token on stdin. Try: pbpaste | node src/index.mjs --login");
    await keychain.set(SERVICE, t);
    const me = await api("/user");
    console.log(`Stored token for ${me.login}.`);
  });
} else if (arg === "--logout") {
  await cli(async () =>
    console.log((await keychain.del(SERVICE)) ? "Token removed." : "No stored token."),
  );
} else if (arg === "--status") {
  await cli(async () => {
    const me = await api("/user");
    const stored = Boolean(await keychain.get(SERVICE));
    console.log(JSON.stringify({ signedIn: true, login: me.login, source: stored ? "keychain" : "gh cli" }, null, 2));
  });
} else {
  serve({
    name: "github-mcp",
    version: "0.1.0",
    tools: TOOLS,
    call,
    remedy:
      "Not signed in to GitHub. Run `gh auth login`, or store a read-only " +
      "fine-grained token with `pbpaste | node mcp/github/src/index.mjs --login`.",
  });
}
