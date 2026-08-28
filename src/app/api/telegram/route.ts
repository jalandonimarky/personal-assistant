import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Telegram bot configuration.
 *
 * The token and allowlist live in the macOS Keychain, never in store.json and
 * never in a file — the relay reads them from the same place. This route only
 * moves them in and reports what is configured.
 *
 * The token is never returned. Once stored it can be replaced but not read
 * back, so a screenshot of this screen leaks nothing.
 */

const TOKEN_SVC = "telegram-bot-token";
const IDS_SVC = "telegram-allowed-ids";

async function kcGet(service: string): Promise<string | null> {
  try {
    const { stdout } = await run("security", [
      "find-generic-password", "-s", service, "-a", "default", "-w",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function kcSet(service: string, value: string) {
  await run("security", [
    "add-generic-password", "-U", "-s", service, "-a", "default", "-w", value,
  ]);
}

async function kcDel(service: string) {
  await run("security", ["delete-generic-password", "-s", service, "-a", "default"]).catch(
    () => {},
  );
}

/** Ask Telegram who this token belongs to. Also validates it. */
async function whoIs(token: string) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || "Telegram rejected the token.");
  return json.result as { username: string; first_name: string; id: number };
}

/** Is the relay process alive? */
async function relayRunning(): Promise<boolean> {
  try {
    await run("pgrep", ["-f", "bot/telegram.mjs"]);
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const token = await kcGet(TOKEN_SVC);
  const ids = (await kcGet(IDS_SVC)) ?? "";
  const running = await relayRunning();

  if (!token) {
    return NextResponse.json({
      configured: false,
      allowedIds: ids,
      running,
      hint: "Create a bot with @BotFather in Telegram, then paste the token it gives you.",
    });
  }

  try {
    const me = await whoIs(token);
    return NextResponse.json({
      configured: true,
      bot: `@${me.username}`,
      allowedIds: ids,
      running,
      // Never the token itself — only enough to recognise which one is stored.
      tokenTail: token.slice(-4),
    });
  } catch (e) {
    return NextResponse.json({
      configured: true,
      invalid: true,
      allowedIds: ids,
      running,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  if (body.action === "clear") {
    await kcDel(TOKEN_SVC);
    await kcDel(IDS_SVC);
    return NextResponse.json({ ok: true, message: "Telegram configuration removed." });
  }

  const out: Record<string, unknown> = { ok: true };

  if (typeof body.token === "string" && body.token.trim()) {
    const token = body.token.trim();
    let me;
    try {
      me = await whoIs(token);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Token rejected." },
        { status: 400 },
      );
    }
    await kcSet(TOKEN_SVC, token);
    out.bot = `@${me.username}`;
  }

  if (typeof body.allowedIds === "string") {
    // Digits and commas only — this is read back by the relay and compared
    // against a numeric id, so anything else is a mistake worth refusing.
    const cleaned = body.allowedIds
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (cleaned.some((s: string) => !/^\d+$/.test(s))) {
      return NextResponse.json(
        { error: "User ids are numeric. Separate several with commas." },
        { status: 400 },
      );
    }
    await kcSet(IDS_SVC, cleaned.join(","));
    out.allowedIds = cleaned.join(",");
  }

  out.message = "Saved. Restart the relay for changes to take effect.";
  return NextResponse.json(out);
}
