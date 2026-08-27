import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

/**
 * Serves the in-repo docs so they're reachable from the UI.
 *
 * `docs/` sits outside `public/`, so Next won't serve it statically. Reading it
 * through a route keeps one copy of each document on disk — the alternative,
 * duplicating them into `public/`, guarantees the two drift apart.
 *
 * Allowlisted rather than path-joined: the slug arrives from the URL, and this
 * app's rule is that paths it did not choose itself are untrusted.
 */
const DOCS: Record<string, string> = {
  ingest: "ingest.html",
  prd: "prd.html",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const file = DOCS[slug];
  if (!file) return new Response("Not found", { status: 404 });

  const full = path.join(process.cwd(), "docs", file);
  let html: string;
  try {
    html = fs.readFileSync(full, "utf8");
  } catch {
    return new Response(`Missing docs/${file}`, { status: 404 });
  }

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Always fresh — the file is edited in place during development.
      "cache-control": "no-store",
    },
  });
}
