import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Secret storage in the macOS Keychain.
 *
 * Tokens never touch the repo, a dotfile, or the assistant's store.json, and
 * are never passed on argv — argv is visible in the process list and shell
 * history. `security -w` takes the value as an argument to the keychain tool
 * itself, which is why writes go through this module rather than a shell line.
 */

export async function get(service, account = "default") {
  try {
    const { stdout } = await run("security", [
      "find-generic-password", "-s", service, "-a", account, "-w",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function set(service, value, account = "default") {
  await run("security", [
    "add-generic-password", "-U", "-s", service, "-a", account, "-w", value,
  ]);
}

export async function del(service, account = "default") {
  try {
    await run("security", ["delete-generic-password", "-s", service, "-a", account]);
    return true;
  } catch {
    return false;
  }
}

/** Read a secret from stdin so it never appears in argv or shell history. */
export function readSecret() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf.trim()));
  });
}
