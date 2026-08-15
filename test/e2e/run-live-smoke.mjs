import { access, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(currentDirectory, "../..");
const extensionDirectory = resolve(repositoryDirectory, "extension");
const userDataDirectory = resolve(repositoryDirectory, ".playwright/instagram-live-profile");

async function findCachedChromiumExecutable() {
  if (process.platform !== "darwin") return undefined;
  const cacheDirectory = resolve(homedir(), "Library", "Caches", "ms-playwright");
  const directories = await readdir(cacheDirectory, { withFileTypes: true }).catch(() => []);
  const chromiumDirectories = directories
    .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
    .sort((a, b) => Number(b.name.slice(9)) - Number(a.name.slice(9)));

  for (const directory of chromiumDirectories) {
    const executable = resolve(
      cacheDirectory, directory.name, "chrome-mac-arm64", "Google Chrome for Testing.app",
      "Contents", "MacOS", "Google Chrome for Testing",
    );
    if (await access(executable).then(() => true).catch(() => false)) return executable;
  }
  return undefined;
}

if (!process.execArgv.includes("--test") && !process.env.NODE_TEST_CONTEXT) {
await mkdir(userDataDirectory, { recursive: true });
const context = await chromium.launchPersistentContext(userDataDirectory, {
  channel: "chromium",
  executablePath: await findCachedChromiumExecutable(),
  headless: false,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    `--disable-extensions-except=${extensionDirectory}`,
    `--load-extension=${extensionDirectory}`,
  ],
});

const worker = context.serviceWorkers()[0]
  ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
if (!worker.url().startsWith("chrome-extension://")) {
  await context.close();
  throw new Error(`Extension service worker did not load: ${worker.url()}`);
}

const extensionOrigin = worker.url().slice(0, worker.url().indexOf("/", "chrome-extension://".length));
const page = context.pages()[0] ?? await context.newPage();
await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
const sidePanelPage = await context.newPage();
await sidePanelPage.goto(`${extensionOrigin}/sidepanel.html`);

console.log("Live smoke browser is ready at https://www.instagram.com/.");
console.log("Log in yourself if Instagram asks. No follow action has been run.");
console.log(`The isolated profile is ${userDataDirectory}. Keep this command running; Ctrl+C closes the browser.`);

await new Promise((resolveSignal) => {
  process.once("SIGINT", resolveSignal);
  process.once("SIGTERM", resolveSignal);
});
await context.close();
}
