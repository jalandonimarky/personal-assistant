import { NextResponse } from "next/server";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getService } from "@/lib/services";

export const dynamic = "force-dynamic";
// Must be a literal — an expression here fails the build.
export const maxDuration = 300;

/**
 * Registers a service's MCP server, or signs the user into one.
 *
 * Both actions run a command, so the inputs are handled carefully:
 * the service id is resolved against the registry and every path, name and
 * environment value is derived server-side. The only client-supplied value
 * that reaches a process is the token, and it goes over **stdin** — argv is
 * visible in the process list and in shell history.
 */

const PATH_EXTRA = [
  `${process.env.HOME}/.npm-global/bin`,
  "/opt/homebrew/bin",
  "/usr/local/bin",
].join(":");

const env = { ...process.env, PATH: `${PATH_EXTRA}:${process.env.PATH ?? ""}` };

function exec(
  cmd: string,
  args: string[],
  stdin?: string,
  timeout = 290_000,
): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out, err: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim(), err: err.trim() });
    });

    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * Half-finished connector logins, keyed by id. Module-level state is safe here
 * for the same reason as in api/auth: routes are bundled separately so this is
 * not shared with others, but both halves of one login live in this file.
 */
const connectorLogins = new Map<
  string,
  {
    child: ChildProcessWithoutNullStreams;
    out: string;
    timer: NodeJS.Timeout;
    svcId: string;
  }
>();

/**
 * Abandon any half-finished sign-in for a service before starting another.
 *
 * A previous attempt keeps its loopback listener for five minutes. Left alone
 * it holds the port, so the next attempt cannot listen — and then the OLD
 * process receives the redirect and rejects it as a state mismatch. Clearing
 * first turns "it just says waiting forever" into something a second click
 * fixes.
 */
function dropLoginsFor(svcId: string) {
  for (const [id, entry] of connectorLogins) {
    if (entry.svcId === svcId) dropLogin(id);
  }
}

/**
 * Free the loopback callback port, whatever is holding it.
 *
 * The in-memory map above is not enough: Next reloads route modules in dev, so
 * a pending login started before a reload is invisible to the map while its
 * process happily keeps the port. That is the failure people actually hit —
 * every later attempt silently fails to listen, the browser redirect reaches
 * the OLD listener, and it is rejected as a state mismatch.
 *
 * Only ever kills a process whose command line is this service's own script,
 * so nothing else on that port is touched.
 */
async function freeCallbackPort(port: number, script: string) {
  const found = await exec("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], undefined, 10_000);
  const pids = found.out.split("\n").map((x) => x.trim()).filter(Boolean);

  for (const pid of pids) {
    const ps = await exec("ps", ["-o", "command=", "-p", pid], undefined, 10_000);
    if (ps.out.includes(script)) await exec("kill", [pid], undefined, 10_000);
  }

  // Give the socket a moment to actually close before the next listen().
  for (let i = 0; i < 20; i++) {
    const still = await exec("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], undefined, 5_000);
    if (!still.out.trim()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function dropLogin(id: string) {
  const p = connectorLogins.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  p.child.kill("SIGTERM");
  connectorLogins.delete(id);
}

async function startConnectorLogin(mcpName: string, label: string, svcId = mcpName) {
  dropLoginsFor(svcId);
  const child = spawn("claude", ["mcp", "login", mcpName, "--no-browser"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const id = `${process.pid}-${Date.now()}`;
  const entry = {
    child,
    out: "",
    timer: setTimeout(() => dropLogin(id), 10 * 60 * 1000),
    svcId,
  };
  connectorLogins.set(id, entry);

  const collect = (d: Buffer) => {
    entry.out += d.toString();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", () => dropLogin(id));

  const url = await new Promise<string | null>((resolve) => {
    const deadline = Date.now() + 25_000;
    const tick = setInterval(() => {
      const m = entry.out.match(/https:\/\/\S+/);
      if (m) {
        clearInterval(tick);
        resolve(m[0].replace(/[.,)]+$/, ""));
      } else if (child.exitCode !== null || Date.now() > deadline) {
        clearInterval(tick);
        resolve(null);
      }
    }, 150);
  });

  if (!url) {
    const out = entry.out.trim();
    dropLogin(id);
    return NextResponse.json(
      { error: out || `Could not start authorisation for ${label}.` },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, id, url });
}

async function finishConnectorLogin(id: string, redirect: string) {
  const entry = connectorLogins.get(id);
  if (!entry) {
    return NextResponse.json(
      { error: "That authorisation is no longer open. Start again." },
      { status: 410 },
    );
  }
  if (!redirect) {
    dropLogin(id);
    return NextResponse.json({ error: "No redirect URL provided." }, { status: 400 });
  }

  const before = entry.out.length;
  entry.child.stdin.write(`${redirect}\n`);

  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 60_000);
    entry.child.once("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });

  const tail = entry.out.slice(before).trim();
  dropLogin(id);

  return code === 0
    ? NextResponse.json({ ok: true, message: "Authorised." })
    : NextResponse.json(
        { error: tail || "Authorisation failed. Copy the whole redirect URL and retry." },
        { status: 400 },
      );
}

/**
 * Provider credentials the panel can set, kept in the Keychain.
 *
 * These are entered here rather than read from the environment because the app
 * normally runs as a launchd agent: there is no interactive shell to export a
 * variable into, so "set GOOGLE_CLIENT_ID and restart" is advice nobody can
 * follow. Everything needed to reach a Google sign-in is now enterable in the
 * UI on a fresh machine.
 */
async function keychainSet(service: string, value: string) {
  return exec("security", [
    "add-generic-password", "-U", "-s", service, "-a", "default", "-w", value,
  ], undefined, 20_000);
}

async function keychainDelete(service: string) {
  return exec("security", ["delete-generic-password", "-s", service, "-a", "default"], undefined, 20_000);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const svc = typeof body.id === "string" ? getService(body.id) : null;
  if (!svc) return NextResponse.json({ error: "Unknown service." }, { status: 400 });
  /**
   * Account connectors have no script of ours to run, but they are not
   * un-fixable — `claude mcp login <name>` authorises one, and --no-browser
   * makes it drivable from here exactly like `claude auth login`: it prints an
   * authorization URL and then blocks reading the redirect URL back on stdin.
   *
   * This used to be a flat refusal, which is why Gmail and Drive looked
   * impossible to configure on a machine that had never authorised them.
   */
  if (svc.auth.kind === "account") {
    if (body.action === "start-connector-login")
      return startConnectorLogin(svc.mcpName, svc.label, svc.id);
    if (body.action === "finish-connector-login") {
      return finishConnectorLogin(String(body.id ?? ""), String(body.redirect ?? ""));
    }
    if (body.action === "cancel-connector-login") {
      dropLogin(String(body.id ?? ""));
      return NextResponse.json({ ok: true });
    }
    if (body.action === "mcp-logout") {
      // Clears the stored OAuth credentials without removing the connector, so
      // Authorise can put it back. Removing it outright is deliberately NOT
      // offered: the entry is synced from the account, so a local remove either
      // comes back on the next sync or hides a connector the person still has
      // switched on — turning it off belongs at claude.ai.
      const r = await exec("claude", ["mcp", "logout", svc.mcpName], undefined, 60_000);
      return r.ok
        ? NextResponse.json({ ok: true, message: `Signed out of ${svc.label}.` })
        : NextResponse.json(
            { error: r.err || r.out || "Sign-out failed." },
            { status: 500 },
          );
    }
    return NextResponse.json(
      {
        error:
          `${svc.label} comes from your Claude account. If it isn't listed, enable the ` +
          `connector at claude.ai first; if it is listed, use Authorise.`,
      },
      { status: 400 },
    );
  }

  if (body.action === "configure" || body.action === "configure-clear") {
    const cc = svc.clientConfig;
    if (!cc) {
      return NextResponse.json(
        { error: `${svc.label} has no client to configure.` },
        { status: 400 },
      );
    }

    if (body.action === "configure-clear") {
      await keychainDelete(cc.idService);
      if (cc.secretService) await keychainDelete(cc.secretService);
      return NextResponse.json({ ok: true, message: "Client removed." });
    }

    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    if (!clientId) {
      return NextResponse.json({ error: "No client ID provided." }, { status: 400 });
    }
    const r = await keychainSet(cc.idService, clientId);
    if (!r.ok) {
      return NextResponse.json(
        { error: r.err || "Could not write to the Keychain." },
        { status: 500 },
      );
    }

    const secret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
    if (cc.secretService) {
      // An empty secret clears any previous one rather than silently keeping it.
      if (secret) await keychainSet(cc.secretService, secret);
      else await keychainDelete(cc.secretService);
    }
    return NextResponse.json({ ok: true, message: "Client saved. Now Set up, then Sign in." });
  }

  if (!svc.script) {
    return NextResponse.json(
      { error: `${svc.label} has nothing to set up here.` },
      { status: 400 },
    );
  }

  const script = path.join(process.cwd(), svc.script);

  if (body.action === "register") {
    const missing = (svc.requiredEnv ?? []).filter((k) => !process.env[k]);
    if (missing.length) {
      // Name the doc: for Google this is a Cloud project and an OAuth client,
      // which is not something to guess at from a variable name alone. Not
      // derived from the script path — Gmail and Drive share one README.
      const doc = svc.setupDoc;
      return NextResponse.json(
        {
          error:
            `Set ${missing.join(" and ")} in the shell running this app, then restart it.` +
            (doc ? ` Setup is in ${doc}.` : ""),
        },
        { status: 400 },
      );
    }
    const envArgs = (svc.requiredEnv ?? []).flatMap((k) => ["-e", `${k}=${process.env[k]}`]);
    /**
     * --scope user, not the default "local".
     *
     * Local scope binds the server to the directory `claude mcp add` ran in —
     * here, the app's own folder. But turns are deliberately run from a
     * NEUTRAL cwd (see scope.ts neutralCwd) so Claude Code does not pull the
     * user's project memory into an assistant's context. From there a
     * locally-scoped server does not exist, and its tools resolve to "No such
     * tool available" even though `claude mcp list` — run in the app folder —
     * happily reports it Connected.
     *
     * That mismatch made every self-hosted server look configured while being
     * unreachable in an actual turn, and pushed the model towards the
     * account-level connectors instead.
     */
    const r = await exec(
      "claude",
      ["mcp", "add", "--scope", "user", svc.mcpName, ...envArgs, "--", "node", script],
      undefined,
      60_000,
    );
    return r.ok
      ? NextResponse.json({ ok: true, message: `${svc.label} registered.` })
      : NextResponse.json({ error: r.err || r.out || "Registration failed." }, { status: 500 });
  }

  /**
   * Two-step OAuth sign-in, so the browser is opened BY THE PAGE rather than by
   * the server. `open` launches the system default browser, which is often not
   * the one the assistant is being used in — and being thrown into a different
   * browser mid-sign-in is both jarring and a good way to end up approving a
   * stale tab. The loopback listener does not care which browser arrives.
   */
  if (body.action === "start-oauth-login") {
    dropLoginsFor(svc.id);
    if (svc.callbackPort) {
      const freed = await freeCallbackPort(svc.callbackPort, script);
      if (!freed) {
        return NextResponse.json(
          {
            error:
              `Port ${svc.callbackPort} is still held by an earlier sign-in. ` +
              `Wait a few seconds and press Sign in again.`,
          },
          { status: 409 },
        );
      }
    }
    const child = spawn("node", [script, "--login", "--no-browser"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const id = `${process.pid}-${Date.now()}`;
    const entry = {
      child,
      out: "",
      timer: setTimeout(() => dropLogin(id), 10 * 60 * 1000),
      svcId: svc.id,
    };
    connectorLogins.set(id, entry);
    const collect = (d: Buffer) => {
      entry.out += d.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => dropLogin(id));

    const url = await new Promise<string | null>((resolve) => {
      const deadline = Date.now() + 25_000;
      const tick = setInterval(() => {
        const m = entry.out.match(/https:\/\/\S+/);
        if (m) {
          clearInterval(tick);
          resolve(m[0].trim());
        } else if (child.exitCode !== null || Date.now() > deadline) {
          clearInterval(tick);
          resolve(null);
        }
      }, 100);
    });

    if (!url) {
      const out = entry.out.trim();
      dropLogin(id);
      return NextResponse.json(
        { error: out || `Could not start sign-in for ${svc.label}.` },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, id, url });
  }

  if (body.action === "cancel-oauth-login") {
    dropLoginsFor(svc.id);
    if (svc.callbackPort) await freeCallbackPort(svc.callbackPort, script);
    return NextResponse.json({ ok: true, message: "Sign-in cancelled." });
  }

  /** Wait for the loopback redirect to complete the sign-in the page opened. */
  if (body.action === "await-oauth-login") {
    const loginId = String(body.loginId ?? "");
    const entry = connectorLogins.get(loginId);
    if (!entry) {
      return NextResponse.json(
        { error: "That sign-in is no longer open. Start again." },
        { status: 410 },
      );
    }
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 290_000);
      entry.child.once("close", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    const tail = entry.out.trim();
    dropLogin(loginId);
    return code === 0
      ? NextResponse.json({ ok: true, message: `Signed in to ${svc.label}.` })
      : NextResponse.json(
          { error: tail.split("\n").pop() || "Sign-in did not complete." },
          { status: 400 },
        );
  }

  if (body.action === "login") {
    if (svc.auth.kind === "token") {
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token) return NextResponse.json({ error: "No token provided." }, { status: 400 });
      const r = await exec("node", [script, "--login"], token, 60_000);
      return r.ok
        ? NextResponse.json({ ok: true, message: r.out || `Signed in to ${svc.label}.` })
        : NextResponse.json({ error: r.err || r.out || "Sign-in failed." }, { status: 400 });
    }

    // OAuth: the server opens a browser and waits for the redirect.
    const r = await exec("node", [script, "--login"]);
    return r.ok
      ? NextResponse.json({ ok: true, message: r.out || `Signed in to ${svc.label}.` })
      : NextResponse.json({ error: r.err || r.out || "Sign-in failed." }, { status: 400 });
  }

  if (body.action === "logout") {
    const r = await exec("node", [script, "--logout"], undefined, 30_000);
    return NextResponse.json({ ok: r.ok, message: r.out || r.err });
  }

  if (body.action === "remove") {
    // Unregister the server from Claude Code. Credentials are cleared first —
    // otherwise removing the entry orphans them, and re-registering later
    // silently reuses a login the person believed they had thrown away.
    await exec("node", [script, "--logout"], undefined, 30_000);
    const r = await exec("claude", ["mcp", "remove", svc.mcpName], undefined, 60_000);
    return r.ok
      ? NextResponse.json({ ok: true, message: `${svc.label} disconnected.` })
      : NextResponse.json(
          { error: r.err || r.out || "Could not disconnect." },
          { status: 500 },
        );
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
