/**
 * Concurrency test for the store lock.
 *
 *   npm run test:store
 *
 * WHY THIS EXISTS: write() is atomic (tmp + rename), so the file can never be
 * truncated — and that atomicity is easy to mistake for safety. It isn't.
 * mutate() is read-modify-write over the WHOLE store, so two writers that each
 * read, then each write, produce last-writer-wins and the loser's turn vanishes
 * with no error anywhere. Measured on the unlocked version: 8 processes × 15
 * writes landed 44 of 120.
 *
 * That stopped being theoretical when the Telegram relay started running as its
 * own always-on process alongside the web UI. A message from the phone arriving
 * while you type in the browser is exactly this race.
 *
 * The test runs real store.js in real subprocesses against a throwaway cwd — a
 * single-process test would pass even with no lock at all, because the whole
 * module is synchronous and never yields.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const work = mkdtempSync(path.join(tmpdir(), "store-test-"));

const WORKERS = 8;
const PER_WORKER = 15;
const EXPECTED = WORKERS * PER_WORKER;

execFileSync(
  "npx",
  [
    "tsc",
    path.join(ROOT, "src/lib/store.ts"),
    "--outDir", path.join(work, "js"),
    "--module", "commonjs",
    "--target", "es2022",
    "--moduleResolution", "node",
    "--esModuleInterop",
    "--skipLibCheck",
  ],
  { cwd: ROOT, stdio: "inherit" },
);

// Compiled output is CommonJS; the repo itself is not.
writeFileSync(path.join(work, "js", "package.json"), '{"type":"commonjs"}');

writeFileSync(
  path.join(work, "worker.cjs"),
  `const { mutate } = require(process.env.STORE_JS);
for (let i = 0; i < ${PER_WORKER}; i++) {
  mutate((s) => {
    s.threads.push({ id: process.env.W + "-" + i, assistantId: "concurrency-probe", title: "t", createdAt: 0 });
  });
}
`,
);

const run = (w) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(work, "worker.cjs")], {
      // cwd decides DATA_DIR and KNOWLEDGE_HOME, so the real store is never touched.
      cwd: work,
      env: { ...process.env, STORE_JS: path.join(work, "js", "store.js"), W: String(w) },
      stdio: "inherit",
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`worker ${w} exited ${code}`)),
    );
  });

await Promise.all(Array.from({ length: WORKERS }, (_, w) => run(w)));

const store = JSON.parse(readFileSync(path.join(work, "data", "store.json"), "utf8"));
const landed = store.threads.filter((t) => t.assistantId === "concurrency-probe").length;

rmSync(work, { recursive: true, force: true });

const ok = landed === EXPECTED;
console.log(
  ok
    ? `PASS  ${WORKERS} concurrent writers × ${PER_WORKER} writes — all ${EXPECTED} landed`
    : `FAIL  expected ${EXPECTED}, landed ${landed} — ${EXPECTED - landed} updates lost to the race`,
);
process.exit(ok ? 0 : 1);
