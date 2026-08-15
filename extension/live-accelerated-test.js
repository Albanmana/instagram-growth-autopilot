export const LIVE_ACCELERATED_TEST_KEY = "instagramFollowupLiveAcceleratedTest";
export const LIVE_TEST_SOURCE_LIMIT = 10;
export const LIVE_TEST_SCALE = 10_080;

// The calendar is accelerated, but Instagram action spacing and batch pauses are not.
// Leave enough wall-clock time for ten real follow and unfollow actions to complete.
const DEFAULT_DURATION_MS = 2 * 60 * 60_000;

function clone(value) {
  return value ? structuredClone(value) : null;
}

function validSession(value) {
  return value
    && typeof value === "object"
    && typeof value.sourceId === "string"
    && value.sourceId.startsWith("instagram-source:")
    && Number.isFinite(value.realStartedAt)
    && Number.isFinite(value.virtualStartedAt)
    && Number.isFinite(value.expiresAt);
}

export function createLiveAcceleratedTest({ storage, now = () => Date.now(), durationMs = DEFAULT_DURATION_MS } = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new Error("Live accelerated test storage must provide get and set.");
  }
  let session = null;

  async function persist(next) {
    session = clone(next);
    await storage.set({ [LIVE_ACCELERATED_TEST_KEY]: clone(session) });
    return clone(session);
  }

  async function load() {
    const result = await storage.get([LIVE_ACCELERATED_TEST_KEY]);
    session = validSession(result[LIVE_ACCELERATED_TEST_KEY]) ? clone(result[LIVE_ACCELERATED_TEST_KEY]) : null;
    if (session?.active && now() >= session.expiresAt) await persist({ ...session, active: false, endedAt: now() });
    return clone(session);
  }

  async function start({ sourceId }) {
    if (typeof sourceId !== "string" || !sourceId.startsWith("instagram-source:")) {
      throw new Error("Live accelerated test requires an existing Instagram source.");
    }
    const startedAt = now();
    return persist({
      active: true,
      sourceId,
      sourceLimit: LIVE_TEST_SOURCE_LIMIT,
      realStartedAt: startedAt,
      virtualStartedAt: startedAt,
      expiresAt: startedAt + durationMs,
    });
  }

  async function stop() {
    if (!session) await load();
    return persist(session ? { ...session, active: false, endedAt: now() } : null);
  }

  function activeSession() {
    if (!session?.active || now() >= session.expiresAt) return null;
    return session;
  }

  function virtualNow() {
    const active = activeSession();
    if (!active) return new Date(now());
    return new Date(active.virtualStartedAt + ((now() - active.realStartedAt) * LIVE_TEST_SCALE));
  }

  function toAlarmTime(virtualDate, { safety = false } = {}) {
    const active = activeSession();
    const target = new Date(virtualDate).getTime();
    if (!active || !Number.isFinite(target)) return new Date(target);
    const virtualCurrent = virtualNow().getTime();
    const virtualDelta = Math.max(0, target - virtualCurrent);
    const realDelay = safety ? virtualDelta : (virtualDelta / LIVE_TEST_SCALE);
    return new Date(now() + realDelay);
  }

  return { load, start, stop, now: virtualNow, toAlarmTime, getSession: () => clone(activeSession()) };
}
