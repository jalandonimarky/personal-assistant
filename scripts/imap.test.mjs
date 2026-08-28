/**
 * Tests for the IMAP response parsing.
 *
 *   npm run test:imap
 *
 * The network half cannot be tested without a real mailbox, but the network
 * half is not where the bugs are. These are: literals that contain blank lines
 * and text that looks like protocol, folded headers, RFC 2047 encoded words,
 * quoted-printable, base64, and multipart bodies with no plain-text part.
 *
 * The literal cases matter most. A reader that scans for line ends without
 * honouring `{n}` will cut a message in half at the first newline in its body,
 * and will mistake a line of quoted email for a tagged completion.
 */
import { Imap, fetchPayloads, parseHeaders, messageText } from "../mcp/lib/imap.mjs";

const CRLF = "\r\n";
let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(
      `FAIL  ${name}\n        got:      ${JSON.stringify(actual)}\n        expected: ${JSON.stringify(expected)}`,
    );
  } else console.log(`PASS  ${name}`);
};

// ---------------- literals ----------------

const body = ["Hi there,", "", "A2 OK this line looks like a tagged reply.", "Regards"].join(CRLF);
const fetchRes =
  `* 1 FETCH (UID 42 BODY[] {${Buffer.byteLength(body)}}` + CRLF +
  body + CRLF +
  ")" + CRLF +
  "A3 OK FETCH completed." + CRLF;

const payloads = fetchPayloads(fetchRes);
check("literal payload extracted whole", payloads.get(42), body);
check("blank line inside a literal survives", payloads.get(42).includes(CRLF + CRLF), true);
check(
  "protocol-looking text inside a literal is not treated as protocol",
  payloads.get(42).includes("A2 OK this line"),
  true,
);

// scanForTag must skip literal bytes when looking for the completion line.
const im = new Imap({ user: "u", pass: "p" });
im.buffer = Buffer.from(fetchRes, "utf8");
check("tagged completion found past a literal", im.scanForTag("A3"), true);
im.buffer = Buffer.from(
  `* 1 FETCH (UID 7 BODY[] {24}` + CRLF + "A9 OK not really the end" + CRLF,
  "utf8",
);
check("a tag inside a literal does not end the response", im.scanForTag("A9"), false);

// ---------------- headers ----------------

const headRaw = [
  "From: Alice <alice@example.com>",
  "Subject: Long subject that is",
  "  folded across two lines",
  "Date: Fri, 29 Aug 2026 09:00:00 +0800",
].join(CRLF);
const h = parseHeaders(headRaw);
check("folded header is unfolded", h.subject, "Long subject that is folded across two lines");
check("header names are lowercased", h.from, "Alice <alice@example.com>");

check(
  "RFC 2047 base64 encoded-word decoded",
  parseHeaders("Subject: =?UTF-8?B?U2FsdSBrYSBiYQ==?=").subject,
  "Salu ka ba",
);
check(
  "RFC 2047 quoted-printable encoded-word decoded",
  parseHeaders("Subject: =?UTF-8?Q?Caf=C3=A9_review?=").subject,
  "Café review",
);

// ---------------- bodies ----------------

const plainMsg = [
  "From: a@b.c",
  "Subject: Plain",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Just words.",
].join(CRLF);
check("plain body", messageText(plainMsg).text, "Just words.");

const qpMsg = [
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Total is =E2=82=AC40 and a soft=",
  "break.",
].join(CRLF);
check("quoted-printable decoded, soft breaks joined", messageText(qpMsg).text, "Total is €40 and a softbreak.");

const b64Msg = [
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("Base sixty four.", "utf8").toString("base64"),
].join(CRLF);
check("base64 decoded", messageText(b64Msg).text, "Base sixty four.");

const multipart = [
  'Content-Type: multipart/alternative; boundary="BOUND"',
  "",
  "--BOUND",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "The plain part.",
  "--BOUND",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>The html part.</p>",
  "--BOUND--",
].join(CRLF);
check("multipart prefers text/plain", messageText(multipart).text, "The plain part.");

const htmlOnly = [
  'Content-Type: multipart/alternative; boundary="B2"',
  "",
  "--B2",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<div>Line one</div><div>Line two</div>",
  "--B2--",
].join(CRLF);
check(
  "html-only mail falls back to stripped text",
  messageText(htmlOnly).text,
  "Line one\nLine two",
);

check(
  "headers still parsed alongside the body",
  messageText(plainMsg).headers.subject,
  "Plain",
);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
