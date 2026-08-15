# Playwright Extension E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the unpacked Chrome extension in a persistent Playwright Chromium, then validate its direct follower-modal path against the real Instagram UI with an explicitly authorized account.

**Architecture:** A small E2E harness launches Chromium with the unpacked MV3 extension and a dedicated temporary profile to verify extension boot. A separate persistent profile opens the real Instagram site for the signed-in, operator-authorized E2E path; the test verifies the visible modal state and local extension history.

**Tech Stack:** Playwright, Node ESM, Manifest V3, Node built-in test runner.

## Global Constraints

- E2E runs use a temporary Chromium profile and never read or copy the user’s Chrome profile.
- The boot check has no Instagram navigation or relationship action.
- Live E2E is opt-in, uses a separate persistent profile, and requires the operator's explicit authorization before it follows anyone.
- Login, challenge, CAPTCHA, or security interstitials require user handoff.
- Keep existing `npm test` unit suite green.

---

### Task 1: Install and expose the E2E runner

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `test/e2e/run-extension-e2e.mjs`

**Interfaces:**
- Produces `npm run test:e2e`, which exits nonzero on an unavailable browser, an extension load failure, or a failed scenario.
- The runner uses `chromium.launchPersistentContext(userDataDir, { channel: "chromium", args: ["--disable-extensions-except=<extensionDir>", "--load-extension=<extensionDir>"] })`.

- [ ] **Step 1: Write the failing runner contract test**

```js
test("e2e script is registered", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(packageJson.scripts["test:e2e"], /run-extension-e2e/);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/e2e-runner-contract.test.mjs`

Expected: FAIL because `test:e2e` is absent.

- [ ] **Step 3: Install the pinned Playwright dependency and add the runner**

```json
{
  "scripts": {
    "test:e2e": "node test/e2e/run-extension-e2e.mjs"
  },
  "devDependencies": {
    "playwright": "^1.57.0"
  }
}
```

Implement a runner that resolves the repository `extension/` directory, creates a temporary `userDataDir`, launches Chromium with the extension flags, waits for a background service worker URL beginning with `chrome-extension://`, and prints a concise diagnostic before closing its context and deleting only its temporary directory.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/e2e-runner-contract.test.mjs` and `npm run test:e2e`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json test/e2e-runner-contract.test.mjs test/e2e/run-extension-e2e.mjs
git commit -m "test: add Playwright extension e2e runner"
```

### Task 2: Verify extension boot through the real extension runtime

**Files:**
- Modify: `test/e2e/run-extension-e2e.mjs`

**Interfaces:**
- The runner loads the service worker for the unpacked extension and verifies its runtime can receive a state request.

- [ ] **Step 1: Write a failing E2E assertion**

```js
assert.match(serviceWorker.url(), /^chrome-extension:\/\//);
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:e2e`.

Expected: FAIL because the unpacked extension is not loaded.

- [ ] **Step 3: Add the minimal boot scenario**

Launch the browser with the extension flags, wait for its service worker, issue `GET_FOLLOWUP_STATE` from the side panel context, then close the temporary context. Do not route, reproduce, or substitute the Instagram website.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:e2e`, then `npm test && git diff --check`.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/run-extension-e2e.mjs
git commit -m "test: add Playwright extension e2e runner"
```

### Task 3: Add a deliberate live-smoke launcher

**Files:**
- Modify: `package.json`
- Create: `test/e2e/run-live-smoke.mjs`
- Modify: `README.md`

**Interfaces:**
- Produces `npm run test:e2e:live`.
- Opens a dedicated persistent profile with the unpacked extension and no test action until the user performs the Instagram login.
- After the user says the login is ready, the operator may run one manual `Scrape + Follow` flow at `limit=1` and inspect local history.

- [ ] **Step 1: Write the failing usage/documentation assertion**

```js
assert.match(await readFile("README.md", "utf8"), /test:e2e:live/);
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/e2e-live-contract.test.mjs`.

- [ ] **Step 3: Add the launcher and instructions**

The launcher creates or reuses `.playwright/instagram-live-profile` (git-ignored), opens Chromium headed with the unpacked extension, prints the side-panel URL, and does not navigate, click, or send any runtime follow intent. README documents that the user must log in themselves and that only a human-authorized limit-one smoke step may follow.

- [ ] **Step 4: Verify and commit**

Run: `node --test test/e2e-live-contract.test.mjs`, `npm run test:e2e`, `npm test`, and `git diff --check`.

```bash
git add package.json README.md test/e2e/run-live-smoke.mjs test/e2e-live-contract.test.mjs .gitignore
git commit -m "test: add isolated Instagram smoke launcher"
```

## Final Verification

- [ ] `npm run test:e2e` completes the extension boot check.
- [ ] `npm test` completes with no failures.
- [ ] `git diff --check` is clean.
- [ ] `npm run test:e2e:live` opens only the isolated browser; no live Instagram action is executed until the user completes the login and tells the operator to continue.
