#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const run = promisify(execFile);

/**
 * Telegram relay for the Personal Assistant.
 *
 * Long polling, deliberately: this process calls OUT to Telegram and asks for
 * new messages. Nothing has to reach in — no open port, no tunnel, no public
 * URL, and none of the LAN exposure that comes with serving the web UI to a
 * phone. It works on cellular and on other people's wifi for the same reason.
 *
 * Zero dependencies — Node 18+ has fetch, and the Bot API is plain HTTPS.
 */

const API_BASE = "https://api.telegram.org/bot";
// Downloads live on a different host path from the method endpoints.
const FILE_BASE = "https://api.telegram.org/file/bot";
const APP = process.env.PA_BASE_URL || "http://127.0.0.1:4317";

// Telegram's hard cap per message.
const MAX_CHARS = 4096;

async function keychain(service, account = "default") {
  try {
    const { stdout } = await run("security", [
      "find-generic-password", "-s", service, "-a", account, "-w",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const token = process.env.TELEGRAM_BOT_TOKEN || (await keychain("telegram-bot-token"));
if (!token) {
  console.error(
    "No bot token. Store one:\n" +
      "  security add-generic-password -U -s telegram-bot-token -a default -w '<token>'",
  );
  process.exit(1);
}

/**
 * Who may talk to this bot. A bot token is effectively discoverable and anyone
 * can message a bot, so without this a stranger reaches your assistant, your
 * knowledge base, and your connectors. Empty list = refuse everyone.
 */
const ALLOWED = (
  process.env.TELEGRAM_ALLOWED_IDS ||
  (await keychain("telegram-allowed-ids")) ||
  ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

async function tg(method, body) {
  const res = await fetch(`${API_BASE}${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

const send = (chatId, text) =>
  tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });

/** Telegram rejects anything over 4096 chars, so split on paragraph seams. */
function chunk(text) {
  if (text.length <= MAX_CHARS) return [text];
  const out = [];
  let buf = "";
  for (const para of text.split("\n\n")) {
    if ((buf + "\n\n" + para).length > MAX_CHARS) {
      if (buf) out.push(buf);
      // A single paragraph can still exceed the cap; hard-split it.
      if (para.length > MAX_CHARS) {
        for (let i = 0; i < para.length; i += MAX_CHARS) out.push(para.slice(i, i + MAX_CHARS));
        buf = "";
      } else buf = para;
    } else buf = buf ? `${buf}\n\n${para}` : para;
  }
  if (buf) out.push(buf);
  return out;
}

// ---------------- App state ----------------

const app = (path, init) =>
  fetch(APP + path, { cache: "no-store", ...init }).then(async (r) => {
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  });

/** chatId → { assistantId, threadId, mode } */
const sessions = new Map();

async function state() {
  return app("/api/state");
}

async function ensureSession(chatId) {
  let s = sessions.get(chatId);
  if (s?.threadId) return s;

  const st = await state();
  // Prefer the assistant this bot is named for; fall back to the first.
  const preferred = (process.env.TELEGRAM_ASSISTANT || "").toLowerCase();
  const assistant =
    st.assistants.find((a) => a.name.toLowerCase() === preferred) ?? st.assistants[0];
  if (!assistant) throw new Error("No assistants configured in the app.");

  const thread = await app("/api/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assistantId: assistant.id, title: "Telegram" }),
  });

  s = {
    assistantId: assistant.id,
    assistantName: assistant.name,
    threadId: thread.id ?? thread.threadId,
    // Read-only by default: you should not be able to authorise file writes by
    // tapping a phone keyboard. /mode authoring is an explicit act.
    mode: "brainstorming",
  };
  sessions.set(chatId, s);
  return s;
}

// ---------------- Commands ----------------

const HELP = [
  "Personal Assistant",
  "",
  "Just type to talk. Photos and PDFs work too — send them with a caption.",
  "Voice notes and video don't: nothing here transcribes them yet.",
  "",
  "Commands:",
  "/new — start a fresh conversation",
  "/who — which assistant and mode you're on",
  "/assistants — list assistants",
  "/use <number> — switch assistant (starts a new conversation)",
  "/mode brainstorming|authoring|critique",
  "/help — this",
].join("\n");

async function handleCommand(chatId, text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ");

  if (cmd === "/start" || cmd === "/help") {
    await send(chatId, HELP);
    return true;
  }

  if (cmd === "/new") {
    const s = sessions.get(chatId);
    if (s) sessions.delete(chatId);
    const fresh = await ensureSession(chatId);
    await send(chatId, `New conversation with ${fresh.assistantName}.`);
    return true;
  }

  if (cmd === "/who") {
    const s = await ensureSession(chatId);
    await send(chatId, `${s.assistantName} · ${s.mode}`);
    return true;
  }

  if (cmd === "/assistants") {
    const st = await state();
    await send(
      chatId,
      st.assistants.map((a, i) => `${i + 1}. ${a.name}`).join("\n") ||
        "No assistants configured.",
    );
    return true;
  }

  if (cmd === "/use") {
    const st = await state();
    const i = Number(arg) - 1;
    const a = st.assistants[i];
    if (!a) {
      await send(chatId, `No assistant ${arg}. Try /assistants.`);
      return true;
    }
    sessions.delete(chatId);
    const s = await ensureSession(chatId);
    // ensureSession picks the first assistant; override to the chosen one.
    s.assistantId = a.id;
    s.assistantName = a.name;
    const thread = await app("/api/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assistantId: a.id, title: "Telegram" }),
    });
    s.threadId = thread.id ?? thread.threadId;
    await send(chatId, `Switched to ${a.name}. New conversation started.`);
    return true;
  }

  if (cmd === "/mode") {
    const allowed = ["brainstorming", "authoring", "critique"];
    if (!allowed.includes(arg)) {
      await send(chatId, `Modes: ${allowed.join(", ")}`);
      return true;
    }
    const s = await ensureSession(chatId);
    s.mode = arg;
    await send(
      chatId,
      arg === "authoring"
        ? "Authoring — this mode can create and edit files."
        : `Mode: ${arg} (read-only).`,
    );
    return true;
  }

  if (cmd.startsWith("/")) {
    await send(chatId, `Unknown command. ${HELP}`);
    return true;
  }
  return false;
}

// ---------------- Attachments ----------------

/** What the CLI's Read tool can actually open. Everything else stays a stub. */
const READABLE_DOC = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/)/i;

/**
 * The attachment on a message, normalised to one shape, or null.
 *
 * Telegram gives each media type its own field rather than a discriminator, so
 * this is an ordered lookup — animations and stickers also carry `document`, so
 * they have to match first.
 *
 * `readable` is the honest bit. Images and PDFs reach the assistant as files it
 * can open. Audio and video cannot: there is no transcription step in this
 * pipeline, and pretending otherwise is worse than saying so.
 */
function attachmentOf(msg) {
  if (process.env.RELAY_DEBUG)
    console.log("update kinds:", Object.keys(msg).filter((k) => k !== "from" && k !== "chat"));

  // PhotoSize[] ordered smallest to largest; the last is the best resolution.
  const photo = msg.photo?.at(-1);
  if (photo)
    return { label: "a photo", fileId: photo.file_id, ext: ".jpg", readable: true };

  if (msg.voice) return { label: "a voice note", fileId: msg.voice.file_id };
  if (msg.audio) return { label: "an audio file", fileId: msg.audio.file_id };
  if (msg.video_note) return { label: "a video note", fileId: msg.video_note.file_id };
  if (msg.video) return { label: "a video", fileId: msg.video.file_id };
  if (msg.animation) return { label: "a GIF", fileId: msg.animation.file_id };
  if (msg.sticker) return { label: "a sticker", fileId: msg.sticker.file_id };

  if (msg.document) {
    const d = msg.document;
    return {
      label: `a file (${d.file_name ?? "unnamed"})`,
      fileId: d.file_id,
      ext: path.extname(d.file_name ?? ""),
      readable: READABLE_DOC.test(d.mime_type ?? ""),
    };
  }

  // These carry no file at all — their whole payload is already words.
  if (msg.location)
    return {
      label: "a location",
      asText: `Location: ${msg.location.latitude}, ${msg.location.longitude}`,
    };
  if (msg.contact)
    return {
      label: "a contact",
      asText: `Contact: ${[msg.contact.first_name, msg.contact.last_name]
        .filter(Boolean)
        .join(" ")} — ${msg.contact.phone_number}`,
    };

  return null;
}

/** The app owns the inbox path; ask once rather than recomputing its rule here. */
let inboxPath = null;
async function inbox() {
  if (inboxPath) return inboxPath;
  const { inbox: dir } = await state();
  if (!dir) throw new Error("The app reported no inbox directory — it needs updating.");
  fs.mkdirSync(dir, { recursive: true });
  inboxPath = dir;
  return inboxPath;
}

/**
 * Pull a file into the inbox and return its absolute path. Telegram caps bot
 * downloads at 20 MB and getFile refuses beyond that, so there is nothing extra
 * to guard here.
 */
async function download(att) {
  const file = await tg("getFile", { file_id: att.fileId });
  const res = await fetch(`${FILE_BASE}${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`file download → ${res.status}`);

  // file_unique_id is stable and contains no separators, so it is a safe
  // basename — a sender-supplied file_name is not.
  const ext = att.ext || path.extname(file.file_path) || "";
  const dest = path.join(await inbox(), `${file.file_unique_id}${ext}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/**
 * Turn a message into the text the assistant sees. Silence was the original
 * bug: a dropped update looks exactly like the relay being down, so every
 * branch here ends in something being said.
 */
async function compose(msg, text) {
  const att = attachmentOf(msg);
  if (!att) return text;

  if (att.asText) return [text, att.asText].filter(Boolean).join("\n\n");

  if (att.readable) {
    // Logged because a silent failure here is indistinguishable from the relay
    // being down — which cost an afternoon of guessing once already.
    console.log(`attachment: ${att.label} → downloading`);
    const file = await download(att);
    console.log(`attachment: saved ${file}`);
    return [
      text,
      `[The user attached ${att.label}, saved at ${file}. Open it with Read ` +
        `before answering — they can see it and expect you to have looked.]`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  // Unreadable and wordless: answering costs a model turn to say one known
  // thing, so the relay says it directly.
  if (!text) return null;

  return [
    text,
    `[The user also sent ${att.label}. This relay carries text, images and PDFs ` +
      `only — there is no transcription step, so you cannot open it. Work from ` +
      `the words above and say plainly that you could not hear or watch it.]`,
  ].join("\n\n");
}

// ---------------- Turn ----------------

async function turn(chatId, content) {
  const s = await ensureSession(chatId);

  // Turns take a while; keep the chat from looking dead.
  const typing = setInterval(
    () => tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}),
    5000,
  );
  await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

  try {
    const before = await app("/api/state");
    const seenMsgs = new Set(
      before.messages.filter((m) => m.threadId === s.threadId).map((m) => m.id),
    );
    const seenQs = new Set(before.questions.map((q) => q.id));

    await app("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: s.threadId,
        content,
        mode: s.mode,
        // Telegram renders no markdown, so ask for plain prose rather than
        // the tables and bold the browser gets.
        channel: "plain",
        // Connectors stay off from chat. There is no navigation here to revoke
        // a grant, so an always-on grant is exactly what we avoided in the UI.
        services: [],
      }),
    });

    const after = await app("/api/state");
    const reply = after.messages
      .filter(
        (m) => m.threadId === s.threadId && m.role === "assistant" && !seenMsgs.has(m.id),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .pop();

    if (!reply) {
      await send(chatId, "No reply came back — check the app.");
      return;
    }

    for (const part of chunk(reply.content)) await send(chatId, part);

    // Anything the assistant parked rather than blocking on.
    // Questions carry `answered`, not a status field, and their ids live in
    // their own namespace — checking them against message ids matched nothing.
    const parked = after.questions.filter(
      (q) => q.threadId === s.threadId && !q.answered && !seenQs.has(q.id),
    );
    if (parked.length) {
      await send(
        chatId,
        "It parked " +
          (parked.length === 1 ? "a question" : `${parked.length} questions`) +
          ":\n\n" +
          parked.map((q) => `• ${q.text}`).join("\n") +
          "\n\nAnswer here and it will re-ground.",
      );
    }
  } catch (e) {
    await send(chatId, `Something failed: ${e.message}`);
  } finally {
    clearInterval(typing);
  }
}

// ---------------- Poll loop ----------------

async function main() {
  const me = await tg("getMe");
  console.log(`Relay running as @${me.username} → ${APP}`);
  if (!ALLOWED.length) {
    console.warn(
      "TELEGRAM_ALLOWED_IDS is empty — every message will be refused. " +
        "Set it to your Telegram user id.",
    );
  }

  let offset = 0;
  for (;;) {
    try {
      const updates = await tg("getUpdates", { offset, timeout: 50 });
      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg) continue;

        const from = msg.from?.id;
        if (!ALLOWED.includes(from)) {
          console.warn(`refused message from ${from} (@${msg.from?.username ?? "?"})`);
          continue;
        }

        // Telegram puts free text on .text only for plain messages; anything
        // with an attachment carries its words on .caption. Gating the whole
        // loop on .text silently dropped every photo and voice note.
        const text = msg.text ?? msg.caption ?? "";
        // Service messages — joins, pins, title changes — have neither.
        if (!text && !attachmentOf(msg)) continue;

        const chatId = msg.chat.id;
        try {
          // A caption cannot be a command, so only plain text routes there.
          if (msg.text && (await handleCommand(chatId, msg.text))) continue;

          const content = await compose(msg, text);
          if (content === null) {
            await send(
              chatId,
              "I can see that arrived, but I can't open it — this relay handles " +
                "text, images and PDFs. Add a caption or tell me what's in it.",
            );
            continue;
          }
          await turn(chatId, content);
        } catch (e) {
          await send(chatId, `Error: ${e.message}`).catch(() => {});
        }
      }
    } catch (e) {
      console.error("poll:", e.message);
      // Back off so a persistent failure does not spin.
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
