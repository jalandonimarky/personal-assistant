/**
 * Tests for the commitment scanner.
 *
 *   npm run test:pulse
 *
 * The scanner is the one part of Pulse that must not be wrong — everything the
 * model says downstream is built on it. No test framework: this compiles
 * staleness.ts to a temp dir and asserts against a fixture with a frozen "today"
 * so results can't drift as the calendar moves.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const work = mkdtempSync(path.join(tmpdir(), "pulse-test-"));

const FIXTURE = `# Sample

## Open

- [ ] Send the vendor the field mapping @sam moved:2026-08-11 blocked:data export
- [ ] Confirm the venue booking @alex moved:2026-07-02 due:2026-09-01
- [ ] Decide Merit gift code scope owner: Alice Chen last-moved:2026-06-20 needs:product scope from Merit
- [ ] Chase the HQ Rental webhook credentials moved:2026-08-13
- [ ] No stamp at all on this one @cob
- [ ] Overdue and cold @sam moved:2026-05-01 due:2026-07-01
- [x] Ship the process flow PDF @sam moved:2026-05-09

## Examples that must NOT be picked up

\`\`\`
- [ ] THIS IS A FENCED EXAMPLE @nobody moved:2020-01-01
\`\`\`

~~~
- [ ] TILDE FENCED @nobody moved:2020-01-01
~~~

Some prose mentioning moved:2026-01-01 that is not a task line.
`;

const fixtures = path.join(work, "fx");
execFileSync("mkdir", ["-p", fixtures]);
writeFileSync(path.join(fixtures, "sample.md"), FIXTURE);

execFileSync(
  "npx",
  [
    "tsc",
    path.join(ROOT, "src/lib/staleness.ts"),
    "--outDir", path.join(work, "js"),
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ],
  { cwd: ROOT, stdio: "inherit" },
);

const { scanRoot, daysBetween, parseDate, bucketFor } = await import(
  pathToFileURL(path.join(work, "js", "staleness.js")).href
);

const scan = scanRoot(fixtures, new Date("2026-08-14T09:00:00"));
const byText = (frag) => scan.open.find((c) => c.text.includes(frag));

let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`FAIL  ${name}\n        got:      ${JSON.stringify(actual)}\n        expected: ${JSON.stringify(expected)}`);
  } else {
    console.log(`PASS  ${name}`);
  }
};

check("fenced examples excluded (6 open, 1 done)", [scan.open.length, scan.done], [6, 1]);
check("no fenced text leaked in", scan.open.some((c) => /FENCED/.test(c.text)), false);

const vendor = byText("vendor");
check("owner from @handle", vendor.owner, "sam");
check("blocked: keeps its spaces", vendor.blockedBy, "data export");
check("text stripped of metadata and handle", vendor.text, "Send the vendor the field mapping");
check("moved: parsed", vendor.lastMoved, "2026-08-11");
check("3 days quiet is fresh", [vendor.daysSince, vendor.bucket], [3, "fresh"]);

const merit = byText("Merit gift code");
check("owner: form with spaces", merit.owner, "Alice Chen");
check("needs: aliases blocked", merit.blockedBy, "product scope from Merit");
check("last-moved: aliases moved", merit.lastMoved, "2026-06-20");
check("55 days quiet is cold", [merit.daysSince, merit.bucket], [55, "cold"]);

const venue = byText("venue");
check("due: parsed, not yet overdue", [venue.due, venue.daysOverdue > 0], ["2026-09-01", false]);

check("overdue days computed", byText("Overdue and cold").daysOverdue, 44);

const nostamp = byText("No stamp at all");
check("missing moved: falls back to mtime, flagged inferred", nostamp.movedInferred, true);
check("owner still found with no other metadata", nostamp.owner, "cob");

const noowner = byText("HQ Rental");
check("no owner is null", noowner.owner, null);
check("moved: with no owner still parses", noowner.lastMoved, "2026-08-13");

check("counts", scan.counts, { open: 6, overdue: 1, cold: 3, stale: 0, aging: 0, fresh: 3 });
check("worst first — most overdue leads", scan.open[0].text.includes("Overdue and cold"), true);

check("daysBetween is signed", daysBetween("2026-08-14", "2026-08-11"), -3);
check("daysBetween across a DST boundary", daysBetween("2026-03-01", "2026-04-01"), 31);
check("slash dates accepted", parseDate("2026/8/1"), "2026-08-01");
check("garbage date rejected", parseDate("last tuesday"), null);
check(
  "bucket boundaries",
  [bucketFor(6), bucketFor(7), bucketFor(13), bucketFor(14), bucketFor(29), bucketFor(30)],
  ["fresh", "aging", "aging", "stale", "stale", "cold"],
);

rmSync(work, { recursive: true, force: true });
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
