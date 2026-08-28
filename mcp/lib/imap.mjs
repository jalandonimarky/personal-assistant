import tls from "node:tls";

/**
 * A very small IMAP client — enough to search and read mail, nothing more.
 *
 * WHY THIS EXISTS. Reaching Gmail through the API costs a Google Cloud project
 * and an OAuth client before anyone can press a button. IMAP with an app
 * password costs a visit to the Google account's security page. For a tool
 * someone installs on a second machine, that difference is the whole game.
 *
 * Zero dependencies, like every other server here. IMAP is a line protocol, so
 * the only genuinely fiddly part is literals: a line ending in `{123}` means
 * "the next 123 bytes are data, not protocol", and a reader that scans for
 * line ends without honouring that will slice a message in half at the first
 * newline in its body. readUntilTagged() below is written around that.
 *
 * WHAT IT DELIBERATELY CANNOT DO. There is no APPEND, no STORE, no EXPUNGE —
 * no way to write, flag, move or delete anything. The connection is opened
 * read-only (EXAMINE, not SELECT), so even a bug cannot mark your mail as read.
 */

const CRLF = "\r\n";

export class Imap {
  constructor({ host = "imap.gmail.com", port = 993, user, pass }) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.pass = pass;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.tagSeq = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect({ host: this.host, port: this.port }, () => resolve());
      this.socket.on("data", (d) => {
        this.buffer = Buffer.concat([this.buffer, d]);
      });
      this.socket.on("error", reject);
      this.socket.setTimeout(60_000, () => {
        this.socket.destroy(new Error("IMAP timed out"));
      });
    }).then(() => this.readUntil(/^\* OK/m));
  }

  close() {
    try {
      this.socket?.end();
    } catch {
      /* already gone */
    }
  }

  /** Wait until the accumulated buffer matches, then return and consume it. */
  readUntil(re) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 60_000;
      const tick = setInterval(() => {
        const text = this.buffer.toString("utf8");
        if (re.test(text)) {
          clearInterval(tick);
          this.buffer = Buffer.alloc(0);
          resolve(text);
        } else if (Date.now() > deadline) {
          clearInterval(tick);
          reject(new Error("IMAP read timed out"));
        }
      }, 20);
    });
  }

  /**
   * Read until the tagged completion line, honouring literals.
   *
   * Scanning is done from the start of the buffer every time rather than
   * incrementally — responses here are small, and the simple version is the
   * one that is obviously correct about literal boundaries.
   */
  readUntilTagged(tag) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 120_000;
      const tick = setInterval(() => {
        const done = this.scanForTag(tag);
        if (done) {
          clearInterval(tick);
          const text = this.buffer.toString("utf8");
          this.buffer = Buffer.alloc(0);
          const line = text.split(CRLF).find((l) => l.startsWith(`${tag} `)) ?? "";
          if (/^\S+ (NO|BAD)/i.test(line)) {
            reject(new Error(line.replace(/^\S+ /, "")));
          } else {
            resolve(text);
          }
        } else if (Date.now() > deadline) {
          clearInterval(tick);
          reject(new Error("IMAP command timed out"));
        }
      }, 20);
    });
  }

  /** True once a tagged completion line exists outside any literal. */
  scanForTag(tag) {
    const buf = this.buffer;
    let i = 0;
    while (i < buf.length) {
      const nl = buf.indexOf("\r\n", i, "utf8");
      if (nl < 0) return false;
      const line = buf.toString("utf8", i, nl);
      i = nl + 2;

      // `{123}` at end of line: the next 123 bytes are data, skip them whole.
      const lit = line.match(/\{(\d+)\}$/);
      if (lit) {
        i += Number(lit[1]);
        continue;
      }
      if (line.startsWith(`${tag} `)) return true;
    }
    return false;
  }

  async command(cmd) {
    const tag = `A${++this.tagSeq}`;
    this.buffer = Buffer.alloc(0);
    this.socket.write(`${tag} ${cmd}${CRLF}`);
    return this.readUntilTagged(tag);
  }

  async login() {
    // Literal form, so a password containing spaces or quotes cannot break out
    // of the command line.
    const tag = `A${++this.tagSeq}`;
    this.buffer = Buffer.alloc(0);
    const user = JSON.stringify(this.user);
    this.socket.write(`${tag} LOGIN ${user} {${Buffer.byteLength(this.pass)}}${CRLF}`);
    await this.readUntil(/^\+/m);
    this.socket.write(this.pass + CRLF);
    const res = await this.readUntilTagged(tag);
    return res;
  }

  /** EXAMINE, not SELECT: read-only, so nothing can be marked as read. */
  examine(mailbox) {
    return this.command(`EXAMINE ${JSON.stringify(mailbox)}`);
  }

  async mailboxes() {
    const res = await this.command('LIST "" "*"');
    return res
      .split(CRLF)
      .filter((l) => l.startsWith("* LIST"))
      .map((l) => {
        const m = l.match(/"([^"]*)"\s*$/) || l.match(/\s(\S+)\s*$/);
        return m ? m[1] : null;
      })
      .filter(Boolean);
  }

  /** Gmail's own search syntax, via the X-GM-RAW extension. */
  async search(query) {
    const res = await this.command(`UID SEARCH X-GM-RAW ${JSON.stringify(query)}`);
    const line = res.split(CRLF).find((l) => l.startsWith("* SEARCH")) ?? "";
    return line
      .replace("* SEARCH", "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  }

  /** Raw FETCH text for a set of uids. Callers pick the pieces apart. */
  fetch(uids, what) {
    return this.command(`UID FETCH ${uids.join(",")} (${what})`);
  }
}

// ---------------- Parsing ----------------

/** Split one FETCH response into per-message literal payloads, keyed by uid. */
export function fetchPayloads(res) {
  const out = new Map();
  const lines = res.split(CRLF);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\* \d+ FETCH .*?UID (\d+).*\{(\d+)\}$/);
    if (!m) continue;
    const uid = Number(m[1]);
    const bytes = Number(m[2]);
    // The literal begins on the next line; rejoin until we have its length.
    let payload = "";
    let j = i + 1;
    while (j < lines.length && Buffer.byteLength(payload) < bytes) {
      payload += (payload ? CRLF : "") + lines[j];
      j++;
    }
    out.set(uid, payload.slice(0, bytes));
    i = j - 1;
  }
  return out;
}

export function parseHeaders(raw) {
  const headers = {};
  // Unfold continuation lines before splitting on ':'.
  const unfolded = raw.replace(/\r\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = decodeWords(m[2].trim());
  }
  return headers;
}

/** RFC 2047 encoded-words, which is how non-ASCII subjects arrive. */
function decodeWords(s) {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, text) => {
    try {
      if (enc.toUpperCase() === "B") {
        return Buffer.from(text, "base64").toString("utf8");
      }
      return Buffer.from(
        text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (__, h) =>
          String.fromCharCode(parseInt(h, 16)),
        ),
        "binary",
      ).toString("utf8");
    } catch {
      return text;
    }
  });
}

function decodeBody(body, encoding, charset) {
  const enc = (encoding || "").toLowerCase();
  let buf;
  if (enc === "base64") buf = Buffer.from(body.replace(/\s+/g, ""), "base64");
  else if (enc === "quoted-printable") {
    buf = Buffer.from(
      body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
      "binary",
    );
  } else buf = Buffer.from(body, "utf8");

  const cs = (charset || "utf8").toLowerCase();
  try {
    return buf.toString(/utf-?8/.test(cs) ? "utf8" : "latin1");
  } catch {
    return buf.toString("utf8");
  }
}

/**
 * Pull readable text out of a raw RFC 822 message.
 *
 * Prefers text/plain and falls back to text/html with tags stripped — plenty
 * of mail carries no plain part at all, and returning nothing for those reads
 * to the user as "the message was empty".
 */
export function messageText(raw) {
  const split = raw.indexOf("\r\n\r\n");
  const headRaw = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? "" : raw.slice(split + 4);
  const headers = parseHeaders(headRaw);
  const ctype = headers["content-type"] ?? "text/plain";

  const boundary = ctype.match(/boundary="?([^";]+)"?/i)?.[1];
  if (!boundary) {
    const text = decodeBody(
      body,
      headers["content-transfer-encoding"],
      ctype.match(/charset="?([^";]+)"?/i)?.[1],
    );
    return { headers, text: /html/i.test(ctype) ? stripHtml(text) : text };
  }

  let plain = null;
  let html = null;
  for (const part of body.split(`--${boundary}`)) {
    const s = part.indexOf("\r\n\r\n");
    if (s < 0) continue;
    const ph = parseHeaders(part.slice(0, s));
    const pt = ph["content-type"] ?? "";
    const decoded = decodeBody(
      part.slice(s + 4),
      ph["content-transfer-encoding"],
      pt.match(/charset="?([^";]+)"?/i)?.[1],
    );
    if (/text\/plain/i.test(pt) && plain === null) plain = decoded;
    else if (/text\/html/i.test(pt) && html === null) html = decoded;
    // Nested multiparts are not walked — one level covers ordinary mail, and
    // the html fallback catches most of what it misses.
  }
  const text = plain ?? (html ? stripHtml(html) : "");
  return { headers, text: text.replace(/\n{3,}/g, "\n\n").trim() };
}

function stripHtml(s) {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n");
}
