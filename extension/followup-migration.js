import { normalizeGrowthState } from "./followup-store.js";

export const GROWTH_MIGRATION_RECEIPT_KEY = "instagramGrowthAutopilotMigration";
export const GROWTH_MIGRATION_BACKUP_KEY = "instagramGrowthAutopilotBackup";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function defaultSha256(value) {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is required to verify growth migration.");
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stateCounts(state) {
  return {
    sources: state.sources.length,
    candidates: state.candidates.length,
    history: state.history.length,
  };
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error || "Unknown migration error");
  return message.slice(0, 240);
}

export async function runGrowthMigration({
  storage,
  store,
  readLegacySnapshot,
  now = () => new Date(),
  sha256 = defaultSha256,
} = {}) {
  if (!storage?.get || !storage?.set) throw new Error("Chrome storage is required for growth migration.");
  if (!store?.load || !store?.save) throw new Error("A normalized local store is required for growth migration.");
  if (typeof readLegacySnapshot !== "function") throw new Error("A legacy snapshot reader is required for growth migration.");
  if (typeof sha256 !== "function") throw new Error("A SHA-256 function is required for growth migration.");

  const currentTime = now();
  if (!(currentTime instanceof Date) || Number.isNaN(currentTime.getTime())) throw new Error("Migration now must be a valid date.");
  const at = currentTime.toISOString();
  const { [GROWTH_MIGRATION_RECEIPT_KEY]: existingReceipt } = await storage.get([GROWTH_MIGRATION_RECEIPT_KEY]);
  if (existingReceipt?.status === "completed") {
    return { status: "completed", state: await store.load(), receipt: structuredClone(existingReceipt) };
  }

  const previousState = await store.load();
  const receipt = {
    migrationVersion: 1,
    status: "copying",
    startedAt: existingReceipt?.startedAt || at,
    updatedAt: at,
    attemptCount: (existingReceipt?.attemptCount || 0) + 1,
  };
  await storage.set({ [GROWTH_MIGRATION_RECEIPT_KEY]: receipt });

  try {
    const legacySnapshot = await readLegacySnapshot();
    const normalized = normalizeGrowthState(legacySnapshot, currentTime, { migrateLegacy: true });
    const sourceChecksum = await sha256(normalized);
    const canonical = await store.save(normalized);
    await storage.set({ [GROWTH_MIGRATION_BACKUP_KEY]: structuredClone(normalized) });
    const stored = await store.load();
    const storedChecksum = await sha256(stored);
    const sourceCounts = stateCounts(normalized);
    const storedCounts = stateCounts(stored);
    if (sourceChecksum !== storedChecksum || stableJson(sourceCounts) !== stableJson(storedCounts)) {
      await store.save(previousState);
      throw new Error("Migration checksum verification failed.");
    }
    const completedReceipt = {
      ...receipt,
      status: "completed",
      updatedAt: at,
      completedAt: at,
      sourceChecksum,
      storedChecksum,
      counts: sourceCounts,
    };
    await storage.set({ [GROWTH_MIGRATION_RECEIPT_KEY]: completedReceipt });
    return { status: "completed", state: canonical, receipt: completedReceipt };
  } catch (error) {
    const blockedReceipt = {
      ...receipt,
      status: "blocked",
      updatedAt: at,
      error: safeError(error),
    };
    await storage.set({ [GROWTH_MIGRATION_RECEIPT_KEY]: blockedReceipt });
    return { status: "blocked", receipt: blockedReceipt };
  }
}

