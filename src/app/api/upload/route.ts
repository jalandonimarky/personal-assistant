import { NextResponse } from "next/server";
import { storeUpload, MAX_UPLOAD_BYTES, type StoredFile } from "@/lib/files";

export const dynamic = "force-dynamic";
// Must be a literal — an expression here fails the build.
// LibreOffice conversions are slow, and several files may queue behind one.
export const maxDuration = 600;

/**
 * Accept files from the composer and put them where the CLI can read them.
 *
 * Files land in the shared inbox rather than an assistant's knowledge
 * directory: an attachment is transient scratch, and knowledge directories are
 * what an assistant deliberately writes, not a dumping ground. The inbox is
 * already passed to every turn as --add-dir (see scope.ts), so nothing extra
 * has to be granted for this to work.
 *
 * Extraction happens here, not at question time — see lib/files.ts for why.
 */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected a multipart upload." },
      { status: 400 },
    );
  }

  const entries = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!entries.length) {
    return NextResponse.json({ error: "No files were sent." }, { status: 400 });
  }

  const stored: StoredFile[] = [];
  const rejected: { name: string; error: string }[] = [];

  for (const file of entries) {
    if (file.size > MAX_UPLOAD_BYTES) {
      rejected.push({
        name: file.name,
        error: `too large (${Math.round(file.size / 1024 / 1024)} MB, limit ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`,
      });
      continue;
    }
    if (file.size === 0) {
      rejected.push({ name: file.name, error: "empty file" });
      continue;
    }

    try {
      const buf = Buffer.from(await file.arrayBuffer());
      stored.push(await storeUpload(file.name, buf));
    } catch (e) {
      rejected.push({
        name: file.name,
        error: e instanceof Error ? e.message : "could not be saved",
      });
    }
  }

  // A partial success is still a success — the composer shows what landed and
  // what didn't, rather than discarding six good files because one was 40 MB.
  return NextResponse.json({ ok: stored.length > 0, files: stored, rejected });
}
