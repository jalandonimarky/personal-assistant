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

/** Does a Keychain entry exist? Read-only — the value is never returned. */
async function keychainHas(service: string): Promise<boolean> {
  try {
    await run("security", ["find-generic-password", "-s", service, "-a", "default"], {
      env,
      timeout: 15000,
    });
    return true;
  } catch {
    return false;
  }
}

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
    authNote: svc.authNote,
    clientConfig: svc.clientConfig,
    hasWrite: hasWrite(svc),
    /** Is this server registered with Claude Code? Gates Disconnect. */
    registered: reg.has(svc.mcpName),
  };

  const known = reg.has(svc.mcpName);
  const healthy = reg.get(svc.mcpName) === true;

  /**
   * Account connectors come down from claude.ai, but "not working" covers two
   * different problems and the old message collapsed them into one dead end:
   *
   *   present in `claude mcp list` but unhealthy → enabled on the account,
   *     just not authorised on THIS machine. `claude mcp login` fixes it, and
   *     we can drive that (see api/services/connect).
   *   absent entirely → not enabled on the account. Nothing local can fix it;
   *     the person has to switch it on at claude.ai first.
   *
   * A new machine hits the second case, which is why setting these up appeared
   * impossible from the app.
   */
  if (svc.auth.kind === "account") {
    if (healthy) {
      return {
        ...base,
        state: "ready" as State,
        detail: "Connected through your Claude account",
      };
    }
    if (known) {
      return {
        ...base,
        state: "needs-auth" as State,
        detail: `Enabled on your Claude account, but not authorised on this machine yet.`,
        canLogin: true,
      };
    }
    return {
      ...base,
      state: "needs-setup" as State,
      detail: `Not enabled on your Claude account. Turn the ${svc.label} connector on, then re-check.`,
      setupUrl: svc.auth.setupUrl,
    };
  }

  /**
   * A missing provider client is the FIRST thing to report. Registering the
   * server or offering Sign in before it exists just produces a failure two
   * steps later, which is exactly how this read as "no way to sign in".
   */
  if (svc.clientConfig) {
    const envHas = (svc.clientConfig.idService === "google-oauth-client-id"
      ? Boolean(process.env.GOOGLE_CLIENT_ID)
      : false);
    if (!envHas && !(await keychainHas(svc.clientConfig.idService))) {
      return {
        ...base,
        state: "needs-setup" as State,
        detail: svc.clientConfig.prompt ?? "Add credentials before signing in.",
        canConfigure: true,
      };
    }
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
        // "local" is what a server with no credential of its own reports.
        canSignOut: s.account !== "local",
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
  /**
   * Advanced variants stay hidden until their client exists. Otherwise the
   * panel shows two Gmails and two Drives to someone who only ever wanted the
   * zero-setup one, and the easy path stops looking like the easy path.
   */
  const visible = [];
  for (const svc of SERVICES) {
    if (!svc.advanced) {
      visible.push(svc);
      continue;
    }
    const cc = svc.clientConfig;
    const configured =
      cc &&
      (Boolean(process.env.GOOGLE_CLIENT_ID) || (await keychainHas(cc.idService)));
    if (configured) visible.push(svc);
  }

  const services = await Promise.all(visible.map((s) => probe(s, reg)));
  const body = { services };
  cache = { at: Date.now(), body };
  return NextResponse.json({ ...body, cached: false, ageMs: 0 });
}
