import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "playwright/test";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const extensionDirectory = resolve(currentDirectory, "../../extension");
const stateKey = "instagramFollowupState";
const futureSourceScanAt = "2099-01-01T00:00:00.000Z";
const serviceE2e = process.env.FOLLOWUP_E2E_SERVICE === "1";
const userDataDirectory = await mkdtemp(
  resolve(tmpdir(), "instagram-followup-e2e-"),
);

function isInstagramUrl(value) {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
    return hostname === "instagram.com" || hostname.endsWith(".instagram.com");
  } catch {
    return false;
  }
}

async function findCachedChromiumExecutable() {
  if (process.platform !== "darwin") return undefined;

  const cacheDirectory = resolve(homedir(), "Library", "Caches", "ms-playwright");
  const directories = await readdir(cacheDirectory, { withFileTypes: true }).catch(() => []);
  const chromiumDirectories = directories
    .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
    .sort((a, b) => Number(b.name.slice(9)) - Number(a.name.slice(9)));

  for (const directory of chromiumDirectories) {
    const executable = resolve(
      cacheDirectory,
      directory.name,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    );
    if (await access(executable).then(() => true).catch(() => false)) return executable;
  }

  return undefined;
}

const chromiumExecutable = await findCachedChromiumExecutable();

let context;
const instagramActivity = [];

try {
  context = await chromium.launchPersistentContext(userDataDirectory, {
    channel: "chromium",
    executablePath: chromiumExecutable,
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ],
  });
  context.on("request", (request) => {
    if (isInstagramUrl(request.url())) instagramActivity.push(request.url());
  });
  context.on("page", (page) => {
    page.on("framenavigated", (frame) => {
      if (isInstagramUrl(frame.url())) instagramActivity.push(frame.url());
    });
  });

  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 10_000 }));

  if (!worker.url().startsWith("chrome-extension://")) {
    throw new Error(`Extension service worker did not load: ${worker.url()}`);
  }

  const extensionId = new URL(worker.url()).host;
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const panel = context.pages()[0] ?? await context.newPage();
  await panel.goto(`${extensionOrigin}/sidepanel.html`);

  await expect(panel).toHaveURL(`${extensionOrigin}/sidepanel.html`);
  await expect(panel.getByRole("heading", { name: "Growth Autopilot", exact: true }))
    .toBeVisible();

  const sections = ["Autopilot", "Sources", "Growth", "Settings"];
  for (const section of sections) {
    await expect(panel.getByRole("tab", { name: section, exact: true })).toBeVisible();
  }
  await expect(panel.getByRole("tabpanel", { name: "Autopilot" })).toBeVisible();

  if (serviceE2e) {
    if (!process.env.FOLLOWUP_PAIRING_TOKEN) throw new Error("FOLLOWUP_PAIRING_TOKEN is required for service E2E.");
    const health = await panel.evaluate(async () => {
      try { return { ok: (await fetch("http://127.0.0.1:4317/health")).ok }; }
      catch (error) { return { error: error.message }; }
    });
    if (!health.ok) throw new Error(`Extension page cannot reach local service: ${health.error || "non-OK response"}`);
    await panel.getByRole("tab", { name: "Settings", exact: true }).click();
    await panel.getByLabel("Local service URL").fill("http://127.0.0.1:4317");
    await panel.getByLabel("Your Instagram handle").fill("e2e.persistence");
    await panel.getByLabel("Pairing token").fill(process.env.FOLLOWUP_PAIRING_TOKEN);
    await panel.getByRole("button", { name: "Connect and migrate local data", exact: true }).click();
    await expect(panel.getByText(/Connected local Supabase/i)).toBeVisible();
  }

  await panel.getByRole("tab", { name: "Sources", exact: true }).click();
  await expect(panel.getByRole("tabpanel", { name: "Sources" })).toBeVisible();
  await panel.getByLabel("Instagram profile URL or handle").fill("@e2e_local_source");
  await panel.getByRole("button", { name: "Add Source", exact: true }).click();
  await expect(panel.getByText("@e2e_local_source", { exact: true })).toBeVisible();

  if (!serviceE2e) await panel.evaluate(async ({ key, nextSourceScanAt, futureCycleAt }) => {
    const stored = await chrome.storage.local.get(key);
    const state = stored[key];
    if (!state) throw new Error("The source was not persisted in extension storage.");
    state.run = {
      ...state.run,
      nextSourceScanAt,
      sourceScanSourceId: "instagram-source:e2e_local_source",
      cycle: { dueAt: futureCycleAt, stage: "review" },
    };
    state.sources = state.sources.map((source) => ({
      ...source,
      status: "completed",
      lastCollectedAt: new Date().toISOString(),
    }));
    await chrome.storage.local.set({ [key]: state });
  }, {
    key: stateKey,
    nextSourceScanAt: futureSourceScanAt,
    futureCycleAt: new Date(Date.now() + (4 * 3_600_000)).toISOString(),
  });

  await panel.reload();
  await panel.getByRole("tab", { name: "Growth", exact: true }).click();
  await expect(panel.getByRole("tabpanel", { name: "Growth" })).toBeVisible();
  await panel.getByRole("tab", { name: "Settings", exact: true }).click();
  await expect(panel.getByRole("tabpanel", { name: "Settings" })).toBeVisible();
  await panel.getByRole("tab", { name: "Autopilot", exact: true }).click();

  if (!serviceE2e) {
    await panel.getByRole("button", { name: "Start Autopilot" }).click();
    await expect(panel.getByRole("article", { name: "Next global work" }))
      .toContainText(/(?:in (?:\d+d )?\d{2}:\d{2}:\d{2}|Ready now)/i);
    await expect(panel.getByRole("article", { name: "Next 48 hours" }))
      .toHaveCount(0);
    await expect(panel.getByText(/Autopilot on/i)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Pause Autopilot" })).toBeVisible();
  }

  const activeState = await panel.evaluate(() => chrome.runtime.sendMessage({
    type: "GET_FOLLOWUP_STATE",
  }));
  expect(activeState).toMatchObject({
    ok: true,
    state: {
      sources: [{ profileUrl: "https://www.instagram.com/e2e_local_source/" }],
      ...(serviceE2e ? {} : { automationEnabled: true, run: { cycle: { stage: "review" } } }),
    },
  });

  if (!serviceE2e) await panel.evaluate(async (key) => {
    const stored = await chrome.storage.local.get(key);
    const state = stored[key];
    state.automationEnabled = true;
    state.run = { ...state.run, phase: "recovery_required", activeBatch: null };
    await chrome.storage.local.set({ [key]: state });
  }, stateKey);
  await panel.reload();

  if (!serviceE2e) {
    await expect(panel.getByText(/Autopilot on.*Resuming automatically/i)).toBeVisible();
    await expect(panel.getByText(/Verify the last Instagram action/i)).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Pause Autopilot", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  }

  expect(instagramActivity).toEqual([]);
  console.log(`Extension UI contract passed for ${extensionId} with no Instagram activity.`);
} catch (error) {
  console.error(`E2E runner failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await context?.close();
  await rm(userDataDirectory, { recursive: true, force: true });
}
