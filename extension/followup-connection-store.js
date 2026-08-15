const CONNECTION_KEY = "instagramFollowupLocalServiceConnection";
const CACHE_KEY = "instagramFollowupLocalServiceSnapshot";

export function createFollowupConnectionStore({ storage }) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new Error("Follow-up connection storage must provide get and set.");
  }
  return {
    async loadConnection() {
      const { [CONNECTION_KEY]: connection } = await storage.get([CONNECTION_KEY]);
      return connection || null;
    },
    async saveConnection(connection) {
      if (!connection || typeof connection !== "object") throw new Error("A local service connection is required.");
      await storage.set({ [CONNECTION_KEY]: structuredClone(connection) });
      return structuredClone(connection);
    },
    async loadCachedState() {
      const { [CACHE_KEY]: state } = await storage.get([CACHE_KEY]);
      return state || null;
    },
    async saveCachedState(state) {
      await storage.set({ [CACHE_KEY]: structuredClone(state) });
      return structuredClone(state);
    },
  };
}
