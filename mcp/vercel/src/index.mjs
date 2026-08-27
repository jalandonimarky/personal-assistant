#!/usr/bin/env node
import { serve, cli, notAuthenticated } from "../../lib/rpc.mjs";
import * as keychain from "../../lib/keychain.mjs";

const SERVICE = "vercel-mcp-token";
const API = "https://api.vercel.com";

/**
 * Read-only Vercel MCP server.
 *
 * Vercel has no delegated OAuth flow for local tools, so this uses an API token
 * created in the dashboard and stored in the Keychain. Create it scoped to the
 * narrowest team that works — the token itself carries the real authority, and
 * this server's read-only surface is the second line of defence, not the first.
 *
 * DELIBERATELY ABSENT: creating or promoting deployments, deleting anything,
 * and reading environment variables. The first two are irreversible; the third
 * would pull production secrets into a model's context, which is precisely the
 * thing a read-only tool should not do.
 */
async function token() {
  const t = (await keychain.get(SERVICE)) || process.env.VERCEL_TOKEN;
  if (!t) {
    throw notAuthenticated(
      "Not signed in to Vercel. Create a token at vercel.com/account/tokens, " +
        "then: pbpaste | node mcp/vercel/src/index.mjs --login",
    );
  }
  return t;
}

async function api(path, params) {
  const t = await token();
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { authorization: `Bearer ${t}` } });
  if (!res.ok) {
    throw new Error(`Vercel ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

const TOOLS = [
  {
    name: "vercel_list_projects",
    description: "List Vercel projects, with their framework and latest deployment state.",
    inputSchema: {
      type: "object",
      properties: {
        teamId: { type: "string", description: "Optional team id; omit for personal scope." },
        top: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "vercel_list_deployments",
    description:
      "List recent deployments, newest first. Filter to one project with projectId.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        teamId: { type: "string" },
        state: {
          type: "string",
          description: "BUILDING, ERROR, READY, CANCELED, QUEUED",
        },
        top: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "vercel_get_deployment",
    description: "Read one deployment in full — state, target, commit, URLs, and any error.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string", description: "Deployment id or url." },
        teamId: { type: "string" },
      },
      required: ["deploymentId"],
    },
  },
  {
    name: "vercel_deployment_events",
    description:
      "Read the build log for a deployment. Use this to diagnose why a build failed.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        teamId: { type: "string" },
        top: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["deploymentId"],
    },
  },
  {
    name: "vercel_list_domains",
    description: "List domains, with verification status.",
    inputSchema: {
      type: "object",
      properties: { teamId: { type: "string" }, top: { type: "integer", minimum: 1, maximum: 100 } },
    },
  },
];

const when = (ms) => (ms ? new Date(ms).toISOString() : null);

async function call(name, args = {}) {
  const teamId = args.teamId;
  const top = Math.min(Math.max(Number(args.top) || 20, 1), 100);

  switch (name) {
    case "vercel_list_projects": {
      const d = await api("/v9/projects", { teamId, limit: top });
      return {
        projects: (d.projects ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          framework: p.framework,
          updatedAt: when(p.updatedAt),
          latestDeployment: p.latestDeployments?.[0]
            ? {
                state: p.latestDeployments[0].readyState,
                url: p.latestDeployments[0].url,
                createdAt: when(p.latestDeployments[0].createdAt),
              }
            : null,
        })),
      };
    }
    case "vercel_list_deployments": {
      const d = await api("/v6/deployments", {
        teamId,
        projectId: args.projectId,
        state: args.state,
        limit: Math.min(top, 50),
      });
      return {
        deployments: (d.deployments ?? []).map((x) => ({
          id: x.uid,
          name: x.name,
          state: x.state ?? x.readyState,
          target: x.target,
          url: x.url,
          branch: x.meta?.githubCommitRef,
          commit: x.meta?.githubCommitSha?.slice(0, 8),
          message: x.meta?.githubCommitMessage,
          createdAt: when(x.created ?? x.createdAt),
        })),
      };
    }
    case "vercel_get_deployment": {
      const x = await api(`/v13/deployments/${encodeURIComponent(args.deploymentId)}`, { teamId });
      return {
        id: x.id ?? x.uid,
        name: x.name,
        state: x.readyState ?? x.state,
        target: x.target,
        url: x.url,
        aliases: x.alias,
        branch: x.meta?.githubCommitRef,
        commit: x.meta?.githubCommitSha?.slice(0, 8),
        message: x.meta?.githubCommitMessage,
        createdAt: when(x.createdAt),
        readyAt: when(x.ready),
        error: x.errorMessage ?? null,
      };
    }
    case "vercel_deployment_events": {
      const d = await api(`/v3/deployments/${encodeURIComponent(args.deploymentId)}/events`, {
        teamId,
        limit: Math.min(Number(args.top) || 200, 500),
      });
      const rows = Array.isArray(d) ? d : (d.events ?? []);
      return {
        lines: rows
          .map((e) => {
            const text = typeof e.payload?.text === "string" ? e.payload.text : e.text;
            return text ? `${e.type ?? "log"}: ${String(text).trimEnd()}` : null;
          })
          .filter(Boolean)
          .slice(-500),
      };
    }
    case "vercel_list_domains": {
      const d = await api("/v5/domains", { teamId, limit: top });
      return {
        domains: (d.domains ?? []).map((x) => ({
          name: x.name,
          verified: x.verified,
          createdAt: when(x.createdAt),
        })),
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
    const me = await api("/v2/user");
    console.log(`Stored token for ${me.user?.username ?? me.user?.email ?? "(unknown)"}.`);
  });
} else if (arg === "--logout") {
  await cli(async () =>
    console.log((await keychain.del(SERVICE)) ? "Token removed." : "No stored token."),
  );
} else if (arg === "--status") {
  await cli(async () => {
    const me = await api("/v2/user");
    console.log(JSON.stringify({ signedIn: true, user: me.user?.username ?? me.user?.email }, null, 2));
  });
} else {
  serve({
    name: "vercel-mcp",
    version: "0.1.0",
    tools: TOOLS,
    call,
    remedy:
      "Not signed in to Vercel. Create a token at vercel.com/account/tokens, then run " +
      "`pbpaste | node mcp/vercel/src/index.mjs --login`.",
  });
}
