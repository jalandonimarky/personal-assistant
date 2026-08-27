import { NextResponse } from "next/server";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SERVICES, hasWrite, type Service } from "@/lib/services";

const run = promisify(execFile);

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Connection status for each service.
 *
 * The dropdown used to show a tick-box whether or not anything was serving the
 * tools behind it — so granting a service that was never registered looked
 * identical to granting one that works, and only failed mid-turn. This reports
 * the real state instead.
 */

const PATH_EXTRA = [
  `${process.env.HOME}/.npm-global/bin`,
  "/opt/homebrew/bin",
  "/usr/local/bin",
].join(":");

const env = { ...process.env, PATH: `${PATH_EXTRA}:${process.env.PATH ?? ""}` };

export type State = "ready" | "needs-auth" | "needs-setup" | "unavailable";

/**
 * `claude mcp list` health-checks every connected server over the network and
 * takes ~6s, so probing on every panel open is wasteful. Cached briefly.
 *
 * A module-level cache is safe HERE, unlike in store.ts: Next bundles route
 * handlers separately in dev, so this may not be shared — but a cache miss
 * merely costs a re-probe, whereas a missed write loses data.
 */
const TTL_MS = 60_000;
let cache: { at: number; body: unknown } | null = null;

/** Servers the CLI currently knows about, and whether each is healthy. */
async function registered(): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  try {
    const { stdout } = await run("claude", ["mcp", "list"], { env, timeout: 30000 });
    for (const line of stdout.split("\n")) {
      // "name: <command or url> - ✔ Connected"
      const m = line.match(/^(.+?):\s+(.*?)\s+-\s+(.+)$/);
      if (m) map.set(m[1].trim(), /Connected/i.test(m[3]));
    }
  } catch {
    /* CLI missing — every service reports unavailable, which is accurate */
  }
  return map;
}

async function probe(svc: Service, reg: Map<string, boolean>) {
  const base = {
    id: svc.id,
    label: svc.label,
    blurb: svc.blurb,
    auth: svc.auth,
    grants: svc.grants,
    withheld: svc.withheld,
    writeGrants: svc.writeGrants,
    writeNote: svc.writeNote,
    hasWrite: hasWrite(svc),
  };

  const known = reg.has(svc.mcpName);
  const healthy = reg.get(svc.mcpName) === true;

  // Account connectors are managed by Claude Code, not by us.
  if (svc.auth.kind === "account") {
    return {
      ...base,
      state: (healthy ? "ready" : "unavailable") as State,
      detail: healthy
        ? "Connected through your Claude account"
        : `Not connected. Add the ${svc.label} connector to your Claude account, then re-check.`,
    };
  }

  if (!known) {
    return {
      ...base,
      state: "needs-setup" as State,
      detail: "Not registered with Claude Code yet.",
      canRegister: true,
    };
  }

  const missingEnv = (svc.requiredEnv ?? []).filter((k) => !process.env[k]);
  if (missingEnv.length) {
    return {
      ...base,
      state: "needs-setup" as State,
      detail: `Missing configuration: ${missingEnv.join(", ")}.`,
    };
  }

  if (!healthy) {
    return {
      ...base,
      state: "unavailable" as State,
      detail: "Registered, but the server is not responding.",
    };
  }

  // Registered and healthy — is this user signed in?
  try {
    const { stdout } = await run(
      "node",
      [path.join(process.cwd(), svc.script!), "--status"],
      { env, timeout: 30000 },
    );
    const s = JSON.parse(stdout);
    if (s.signedIn) {
      return {
        ...base,
        state: "ready" as State,
        detail: s.account || s.login || s.user || "Signed in",
      };
    }
  } catch {
    /* --status exits non-zero when unauthenticated, which is the signal */
  }

  return { ...base, state: "needs-auth" as State, detail: "Not signed in yet." };
}

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  const fresh = cache && Date.now() - cache.at < TTL_MS;

  if (!force && fresh) {
    return NextResponse.json({
      ...(cache!.body as object),
      cached: true,
      ageMs: Date.now() - cache!.at,
    });
  }

  const reg = await registered();
  const services = await Promise.all(SERVICES.map((s) => probe(s, reg)));
  const body = { services };
  cache = { at: Date.now(), body };
  return NextResponse.json({ ...body, cached: false, ageMs: 0 });
}
