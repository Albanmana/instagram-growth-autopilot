export const HEALTH_KEY = "instagramGrowthAutopilotHealth";

const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000];

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error || "Unknown autopilot error");
  return message.slice(0, 240);
}

function requiresIntervention(message) {
  return /session is unavailable|log in|challenge|unsupported .*version|quota|storage/i.test(message);
}

function emptyHealth() {
  return {
    status: "healthy",
    consecutiveFailures: 0,
  };
}

export function createFollowupHealth({ storage, now = () => new Date(), notify = async () => undefined } = {}) {
  if (!storage?.get || !storage?.set) throw new Error("Chrome storage is required for autopilot health.");
  if (typeof notify !== "function") throw new Error("Autopilot health notify must be a function.");

  async function get() {
    const { [HEALTH_KEY]: stored } = await storage.get([HEALTH_KEY]);
    return stored && typeof stored === "object" ? structuredClone(stored) : emptyHealth();
  }

  async function recordSuccess() {
    const current = now();
    if (!(current instanceof Date) || Number.isNaN(current.getTime())) throw new Error("Autopilot health now must be a valid date.");
    const next = {
      status: "healthy",
      consecutiveFailures: 0,
      lastAttemptAt: current.toISOString(),
      lastSuccessAt: current.toISOString(),
    };
    await storage.set({ [HEALTH_KEY]: next });
    return structuredClone(next);
  }

  async function recordFailure(error) {
    const current = now();
    if (!(current instanceof Date) || Number.isNaN(current.getTime())) throw new Error("Autopilot health now must be a valid date.");
    const previous = await get();
    const message = safeMessage(error);
    const failures = (Number.isInteger(previous.consecutiveFailures) ? previous.consecutiveFailures : 0) + 1;
    const interventionRequired = requiresIntervention(message);
    const next = {
      status: interventionRequired ? "intervention_required" : "retry_scheduled",
      consecutiveFailures: failures,
      lastAttemptAt: current.toISOString(),
      lastSuccessAt: previous.lastSuccessAt,
      lastErrorCode: interventionRequired ? "intervention_required" : "recoverable_error",
      lastErrorMessage: message,
    };
    if (!interventionRequired) {
      const delay = RETRY_DELAYS_MS[Math.min(failures - 1, RETRY_DELAYS_MS.length - 1)];
      next.nextRetryAt = new Date(current.getTime() + delay).toISOString();
    }
    const shouldNotify = interventionRequired && previous.status !== "intervention_required";
    if (shouldNotify) next.notifiedAt = current.toISOString();
    else if (previous.notifiedAt) next.notifiedAt = previous.notifiedAt;
    await storage.set({ [HEALTH_KEY]: next });
    if (shouldNotify) {
      await notify({
        title: "Instagram Growth Autopilot needs attention",
        message,
      });
    }
    return structuredClone(next);
  }

  return { get, recordSuccess, recordFailure };
}

