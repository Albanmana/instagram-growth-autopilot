# Instagram Growth Autopilot

Chrome extension for collecting visible Instagram profile-list entries and
operating a local follow / delayed-unfollow queue. It has no account, API-key,
CRM, Cold DM, or other external-service setup: state stays in the active
Chrome profile's `chrome.storage.local`.

## Before you use it

Load the extension only in a Chrome profile that is already logged in to
Instagram. The extension opens Instagram profile and list pages in that same
profile. To detect a missing session, it opens and waits for a temporary
Instagram tab; if that tab redirects to login, it closes the tab, stops, and
reports that the session is unavailable.

Collection and relationship controls depend on Instagram's live UI. During
collection, the extension follows only visible rows directly in the supplied
profile's Followers modal, spacing those actions with the configured action
delay and recording each outcome in local history. Instagram can change labels,
dialogs, markup, availability, or show only a preview of a followers list. A
collection warning means that the visible result may not be the complete list;
that partial preview is not treated as the full audience. A failed or skipped
action is recorded locally and is not proof that Instagram changed the
relationship.

**Follow and Unfollow are state-changing Instagram actions.** Explicit
authorization naming the exact handle and intended operation (**Follow** or
**Unfollow**) is an external operator procedure, obtained immediately before a
live action. It is not a runtime confirmation or authorization gate in the
extension. Loading the extension, adding a source, inspecting controls, or
starting a review does not itself authorize a relationship change.

## Install unpacked

1. Open `chrome://extensions` and enable Developer mode.
2. Select **Load unpacked** and choose the `extension/` directory.
3. Click the extension toolbar icon to open the side panel.
4. Log in to Instagram in this Chrome profile before collecting or running the
   engine.

## Local workflow

1. Add a source with an Instagram handle or canonical profile URL. The
   extension collects only the supplied profile's visible **followers** list;
   it never uses that profile's Following list as a collection source. **Add
   Source** stores it locally. With automation enabled, **Scrape + Follow**
   opens that Followers modal and follows its visible rows directly, using the
   configured spacing and preserving each result in local history. A preview
   warning means only the currently visible partial list was processed.
2. Review the finite local source list, pending-follow backlog, due-unfollow
   count, and recent local history.
3. **Start Auto** enables the engine and can directly cause live collection
   and/or relationship actions. **Pause** keeps all local data and stops the
   next alarm. **Resume** can directly continue live work from a paused run.
   **Stop** disables automation and clears the next scheduled alarm while
   retaining sources, candidates, history, and any future action/inter-batch
   safety deadline. A later **Start Auto** cannot run before that deadline.
4. **Export JSON** downloads exactly the portable local `version`, `settings`,
   `sources`, `candidates`, and `history`. **Reset Local Data** asks for browser
   confirmation, stops automation, and restores the empty defaults; it cannot
   be undone from the extension.

Sources can be removed when the engine is not collecting or running a batch.
Removing a source intentionally preserves the candidates and history it
previously contributed to, so local provenance remains auditable.

Due unfollows are prioritized only when the engine selects its next batch:
they do not interrupt an active batch or preempt the required inter-batch
pause.

Follow collection acts directly on visible rows in the source's Followers
modal; it does not use the profile-action gateway or navigate to an account's
Following list. Each direct outcome is kept in the local candidate and history
records, and successful follows receive the configured delayed-unfollow due
time. When an unfollow is due, the relationship gateway opens the candidate's
direct canonical `https://www.instagram.com/<handle>/` profile and performs
one verified Unfollow there. The relationship-action module retains a
defensive Following-list row helper, but that branch is covered only by
non-live DOM/UI tests and is not wired into the current engine or gateway.

## Defaults

| Setting | Default |
| --- | ---: |
| Per-source collection limit | 200 |
| Pending-follow backlog maximum | 500 |
| Refill threshold | 100 |
| Batch size | 50 |
| Delay between actions | 10–20 seconds |
| Delay between batches | 5–7 minutes |
| Delay before unfollow | 2 days |

All timing and limits are editable locally. Values must be positive, the
minimum delay cannot exceed its maximum, the refill threshold must stay below
the backlog maximum, and the per-source limit and batch size cannot exceed the
backlog maximum.

## Development and verification

Run the automated suite with:

```bash
npm test
git diff --check
```

The tests exercise the local model, persistent store, scheduling engine,
side-panel controls, Instagram DOM-action safeguards, and follower collection
logic. They do not make an Instagram relationship change or require a logged-in
browser.

### Isolated live browser smoke setup

To open the real Instagram website with this unpacked extension in a separate
Playwright Chrome profile, run:

```bash
npm run test:e2e:live
```

This opens a persistent browser profile in `.playwright/instagram-live-profile`
and navigates to `https://www.instagram.com/`. Log in yourself in that new
browser window if Instagram asks. The launcher only opens the browser and the
extension side panel; it does not scrape, follow, unfollow, or send an extension
runtime intent. Keep the command running while an operator performs a separately
authorized, limit-one smoke test.

See [docs/architecture.md](docs/architecture.md) for the state model and
runtime boundary.
