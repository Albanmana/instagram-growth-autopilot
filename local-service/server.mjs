import { createServer } from "node:http";

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1_000_000) throw new Error("Request body is too large.");
  }
  const value = Buffer.concat(chunks).toString("utf8");
  return value ? JSON.parse(value) : {};
}

function matchedTaskPath(pathname, suffix) {
  const match = pathname.match(new RegExp(`^/v1/tasks/([^/]+)/${suffix}$`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function createLocalService({ controlPlane, config }) {
  if (!controlPlane || !config || config.host !== "127.0.0.1") throw new Error("Local service requires loopback control-plane configuration.");
  const requiresAuthorization = (request) => request.headers.authorization !== `Bearer ${config.pairingToken}`;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${config.host}`);
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, status: "healthy" });
        return;
      }
      if (requiresAuthorization(request)) {
        sendJson(response, 401, { ok: false, error: "Local service pairing is required." });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/provision") {
        const body = await readJson(request);
        sendJson(response, 200, { ok: true, account: await controlPlane.provision(body.handle) });
        return;
      }

      const accountId = request.headers["x-instagram-account-id"];
      if (typeof accountId !== "string" || !accountId) {
        sendJson(response, 400, { ok: false, error: "An Instagram account header is required." });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/account") {
        sendJson(response, 200, { ok: true, account: await controlPlane.getAccount(accountId) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/state") {
        sendJson(response, 200, { ok: true, state: await controlPlane.getState(accountId) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/engine-state") {
        sendJson(response, 200, { ok: true, snapshot: await controlPlane.readEngineState(accountId) });
        return;
      }

      const body = await readJson(request);
      if (request.method === "PUT" && url.pathname === "/v1/engine-state") {
        sendJson(response, 200, { ok: true, snapshot: await controlPlane.replaceEngineState(accountId, body.revision, body.state) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/commands") {
        sendJson(response, 200, { ok: true, state: await controlPlane.command(accountId, body.command) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/tasks/claim") {
        sendJson(response, 200, { ok: true, task: await controlPlane.claim(accountId, body.claimantId) });
        return;
      }
      const startingTaskId = matchedTaskPath(url.pathname, "start");
      if (request.method === "POST" && startingTaskId) {
        sendJson(response, 200, { ok: true, task: await controlPlane.start(accountId, startingTaskId, body.claimToken) });
        return;
      }
      const completingTaskId = matchedTaskPath(url.pathname, "outcome");
      if (request.method === "POST" && completingTaskId) {
        sendJson(response, 200, { ok: true, result: await controlPlane.complete(accountId, completingTaskId, body.claimToken, body.outcome) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/migrations/legacy-state") {
        sendJson(response, 200, { ok: true, result: await controlPlane.importLegacyState(accountId, body.state, body.checksum) });
        return;
      }
      sendJson(response, 404, { ok: false, error: "Route not found." });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve(server.address());
      });
    }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
