/**
 * MCP over stdio: newline-delimited JSON-RPC 2.0.
 *
 * Shared by every server in this folder. Implemented directly rather than via
 * an SDK so these servers have no dependency tree — they run on other people's
 * machines against their accounts, and a server that can be read end to end in
 * one sitting is far easier to approve than one pulling transitive packages.
 */

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

const reply = (id, result) => {
  if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, result });
};

const fail = (id, message, code = -32000) => {
  if (id !== undefined && id !== null) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }
};

/**
 * @param name     server name reported to the client
 * @param version  server version
 * @param tools    MCP tool definitions
 * @param call     async (toolName, args) => any — return value is JSON-encoded
 * @param remedy   shown when call() throws with code NOT_AUTHENTICATED
 */
export function serve({ name, version, tools, call, remedy }) {
  async function handle(msg) {
    const { id, method, params } = msg;

    if (method === "initialize") {
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name, version },
      });
      return;
    }
    if (method === "notifications/initialized" || method === "initialized") return;
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") return reply(id, { tools });

    if (method === "tools/call") {
      try {
        const out = await call(params?.name, params?.arguments ?? {});
        reply(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        // Returned as tool output rather than a protocol error, so the model can
        // relay the remedy to the user instead of the turn simply failing.
        reply(id, {
          isError: true,
          content: [
            {
              type: "text",
              text:
                e.code === "NOT_AUTHENTICATED"
                  ? remedy
                  : `${name} request failed: ${e.message}`,
            },
          ],
        });
      }
      return;
    }

    fail(id, `Unsupported method: ${method}`, -32601);
  }

  // Requests are handled concurrently, so stdin ending does not mean the work
  // is finished. Exiting on "end" would drop replies still in flight.
  let buffer = "";
  const inFlight = new Set();
  let ended = false;
  const drain = () => {
    if (ended && inFlight.size === 0) process.exit(0);
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // Not our frame; ignore rather than crash the transport.
      }
      const task = handle(msg)
        .catch((e) => fail(msg.id, e.message))
        .finally(() => {
          inFlight.delete(task);
          drain();
        });
      inFlight.add(task);
    }
  });
  process.stdin.on("end", () => {
    ended = true;
    drain();
  });
}

/** CLI entry points report problems as one line, not a stack trace. */
export async function cli(fn) {
  try {
    await fn();
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}

export const notAuthenticated = (message) => {
  const e = new Error(message);
  e.code = "NOT_AUTHENTICATED";
  return e;
};
