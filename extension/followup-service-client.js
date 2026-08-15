function localServiceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Follow-up service URL must be an HTTP loopback origin.");
  }
  url.hostname = "127.0.0.1";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function serviceError(payload) {
  return new Error(payload?.error || "Local follow-up service request failed.");
}

export function createFollowupServiceClient({ fetch: fetchImplementation = globalThis.fetch, baseUrl, pairingToken, accountId }) {
  if (typeof fetchImplementation !== "function") throw new Error("A fetch implementation is required.");
  if (typeof pairingToken !== "string" || !pairingToken) throw new Error("A local pairing token is required.");

  const origin = localServiceUrl(baseUrl);

  async function request(path, { method = "GET", body, needsAccount = true } = {}) {
    if (needsAccount && (typeof accountId !== "string" || !accountId)) throw new Error("An Instagram account ID is required.");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetchImplementation(new URL(path, `${origin.href}/`).href, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${pairingToken}`,
          ...(needsAccount ? { "X-Instagram-Account-Id": accountId } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) throw serviceError(payload);
      return payload;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    async provision(handle) { return (await request("/v1/provision", { method: "POST", body: { handle }, needsAccount: false })).account; },
    async getAccount() { return (await request("/v1/account")).account; },
    async getState() { return (await request("/v1/state")).state; },
    async readEngineState() { return (await request("/v1/engine-state")).snapshot; },
    async replaceEngineState(revision, state) {
      return (await request("/v1/engine-state", { method: "PUT", body: { revision, state } })).snapshot;
    },
    async command(command) { return (await request("/v1/commands", { method: "POST", body: { command } })).state; },
    async claimTask(claimantId) { return (await request("/v1/tasks/claim", { method: "POST", body: { claimantId } })).task; },
    async startTask(taskId, claimToken) { return (await request(`/v1/tasks/${encodeURIComponent(taskId)}/start`, { method: "POST", body: { claimToken } })).task; },
    async completeTask(taskId, claimToken, outcome) { return (await request(`/v1/tasks/${encodeURIComponent(taskId)}/outcome`, { method: "POST", body: { claimToken, outcome } })).result; },
    async importLegacyState(state, checksum) { return (await request("/v1/migrations/legacy-state", { method: "POST", body: { state, checksum } })).result; },
  };
}
