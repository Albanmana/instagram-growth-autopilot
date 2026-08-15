# Live Run Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show live manual `Scrape + Follow` progress and the number of confirmed follows in the current run.

**Architecture:** Keep the indicator as ephemeral side-panel state. Capture the persisted history length before the runtime intent, then count only newly returned successful `follow` history entries when the runtime completes. The existing engine and persisted history remain unchanged.

**Tech Stack:** Manifest V3 side panel, vanilla HTML/CSS/JavaScript, Node built-in test runner.

## Global Constraints

- Do not add an Instagram action or alter the persisted follow-up schema.
- Count only `follow` actions with terminal `succeeded` status.
- The animated state must use an accessible live status and respect reduced motion.
- Keep stale polling unable to replace local in-progress state.

---

### Task 1: Define the panel behavior with a failing test

**Files:**
- Modify: `test/sidepanel.test.mjs`

**Interfaces:**
- Consumes: the real panel DOM and `RUN_MANUAL_SOURCE` runtime response.
- Produces: proof that a pending manual run exposes an animated status and a final, successful-follow count.

- [ ] **Step 1: Write the failing test**

```js
test("manual run shows live progress and counts only confirmed follows", { concurrency: false }, async () => {
  const history = [
    { handle: "new-follow", action: "follow", status: "succeeded", at: "2026-08-14T12:00:00.000Z" },
    { handle: "already-following", action: "follow", status: "skipped", at: "2026-08-14T12:00:01.000Z" },
  ];
  await withPanel({ intentHandler: async () => ({ ok: true, state: dashboardState({ history }) }) }, async ({ document }) => {
    const click = document.getElementById("manual-scrape-button").trigger("click");
    assert.equal(document.getElementById("manual-run-status").hidden, false);
    assert.match(document.getElementById("manual-run-status").textContent, /0 followed this run/i);
    await click;
    assert.match(document.getElementById("manual-run-status").textContent, /1 followed this run/i);
    assert.match(document.getElementById("manual-run-status").textContent, /run complete/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sidepanel.test.mjs`

Expected: FAIL because `manual-run-status` does not exist.

### Task 2: Render and animate the manual-run status

**Files:**
- Modify: `extension/sidepanel.html`
- Modify: `extension/sidepanel.css`
- Modify: `extension/sidepanel.js`

**Interfaces:**
- Consumes: a history baseline and the final persisted state returned by `RUN_MANUAL_SOURCE`.
- Produces: `#manual-run-status` with pending, complete, and error states plus its confirmed-follow counter.

- [ ] **Step 1: Add the semantic status row**

```html
<p id="manual-run-status" class="manual-run-status" role="status" aria-live="polite" hidden>
  <span class="manual-run-pulse" aria-hidden="true"></span>
  <span id="manual-run-message">Opening Followers modal and processing visible rows…</span>
</p>
```

- [ ] **Step 2: Add CSS-only motion with reduced-motion fallback**

```css
.manual-run-status.is-running .manual-run-pulse { animation: manual-run-pulse 1s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .manual-run-status.is-running .manual-run-pulse { animation: none; } }
```

- [ ] **Step 3: Add minimal state transitions**

```js
function startManualRunIndicator(history) { /* records history baseline and renders 0 */ }
function completeManualRunIndicator(state) { /* counts new successful follow entries and stops pulse */ }
function failManualRunIndicator(error) { /* stops pulse and preserves partial count */ }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sidepanel.test.mjs`

Expected: PASS.

### Task 3: Verify regression safety

**Files:**
- Modify: `test/sidepanel.test.mjs`

- [ ] **Step 1: Add the failure-state assertion**

```js
assert.match(document.getElementById("manual-run-status").textContent, /run stopped with an error/i);
```

- [ ] **Step 2: Verify focused and full suites**

Run: `node --test test/sidepanel.test.mjs && npm test && git diff --check`

Expected: all tests pass and no whitespace errors.

- [ ] **Step 3: Commit**

```bash
git add extension/sidepanel.html extension/sidepanel.css extension/sidepanel.js test/sidepanel.test.mjs
git commit -m "feat: show live manual follow progress"
```
