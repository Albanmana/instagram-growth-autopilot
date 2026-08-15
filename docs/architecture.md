# Instagram Growth Autopilot Architecture

## Runtime boundary

This Manifest V3 extension is a local Chrome runtime. Its active code uses
Chrome extension APIs and `https://www.instagram.com/*` only; it does not call
a CRM, queue API, Cold DM, or another external application service. The
service worker owns local scheduling and the side panel is its operator UI.

The active Chrome profile must already be authenticated with Instagram. The tab
gateway opens and waits for a temporary Instagram tab; if that tab redirects to
an Instagram login URL, it closes the tab and reports that the user must log
in in this browser. This check cannot guarantee that every Instagram UI action
will remain available.

## Chrome permissions

The manifest needs:

- `storage` for persisted local state;
- `alarms` for future work and delay scheduling;
- `scripting` to inspect and interact with the Instagram tab DOM;
- `sidePanel` for the dashboard; and
- the Instagram host permission to open and operate Instagram pages.

No additional host permission is required for the documented local runtime.

## Persisted local state

All state is one versioned record under `chrome.storage.local` key
`instagramGrowthAutopilotState` (schema version 2). An existing
`instagramFollowupState` record is converted once on startup and retained only
as a rollback copy:

- `automationEnabled` — whether automatic work may run (default `false`);
- `settings` — the validated timing and queue limits;
- `sources` — canonical Instagram source profile URLs and collection status;
- `candidates` — deduplicated Instagram handles and relationship lifecycle;
- `run` — phase, active batch, optional next-work timestamp, and short-lived
  lease; and
- `history` — immutable local snapshots of terminal action attempts.

The initial state has no sources, candidates, or history; phase `idle`; no
active batch; and these defaults:

| Setting | Default |
| --- | ---: |
| `perSourceLimit` | 200 |
| `backlogMaximum` | 500 |
| `refillThreshold` | 100 |
| `batchSize` | 50 |
| `actionDelayMinSeconds` / `actionDelayMaxSeconds` | 10 / 20 |
| `batchDelayMinMinutes` / `batchDelayMaxMinutes` | 5 / 7 |
| `unfollowDelayDays` | 2 |

Exports contain exactly `version`, `settings`, `sources`, `candidates`, and
`history`; they exclude `automationEnabled`, `run`, and every other state
field. Reset stops the engine and replaces the record with that empty initial
state; the side panel requires a confirmation first.

## Engine lifecycle

The engine phases are `idle`, `collecting`, `running_batch`, `waiting`,
`paused`, `blocked`, and `stopped`. The side panel sends local messages to the
service worker:

- **Start Auto** enables automation and can directly cause live collection
  and/or relationship actions.
- **Pause** preserves the queue and cancels the next alarm.
- **Resume** can directly continue live queued work after a pause.
- **Stop** disables automation and clears the next alarm but preserves all
  local sources, candidates, history, and any future action/inter-batch safety
  deadline; a later **Start Auto** cannot schedule before that deadline.
- **Add Source** persists a source without collection. **Scrape + Follow**
  adds (if necessary) and, with automation enabled, opens the supplied
  source's Followers modal to follow its visible rows directly.

Candidates are normalized and deduplicated by case-insensitive handle. The
only collection source is the supplied profile's visible **followers** list;
the supplied profile's Following list is never used for collection. While that
modal is open, Follow acts directly on each visible row, waiting the randomized
configured action delay between rows. Every direct outcome persists the
candidate lifecycle and appends one immutable local history record with handle,
source IDs, action, result, reason, and timestamp. A successful direct follow
records `followedAt` and calculates `unfollowDueAt`; a later successful
unfollow records `unfollowedAt`. A failed action stays retryable with its next
action recorded. The engine completes the active batch and its configured
inter-batch pause before selecting another batch; only then does it prioritize
due unfollows over follow work.

Whenever the service worker loads, and on browser startup or extension install,
it reconciles persisted phases and recreates the next alarm when automation is
enabled. A source scrape truncated only by backlog capacity remains eligible
for a later deeper pass; a pass that reaches the source limit or yields fewer
rows than requested terminalizes it so an empty/duplicate result cannot loop.

## Instagram UI limitations and live-action gate

Collection uses only the currently rendered Instagram **followers** UI. The
Following list is never used to collect candidates. Follow acts directly on
visible rows in that Followers modal and persists each outcome locally; it does
not call the profile-action gateway. The gateway remains the delayed-unfollow
path: it opens the queued candidate's direct canonical profile URL, injects one
verified Unfollow there, and closes that tab. The relationship-action module
also retains a defensive Following-list row helper based on observed UI
structure; it is covered only by non-live DOM/UI tests and is not wired into
the current engine or gateway. Instagram can alter controls, show confirmation
dialogs, rate-limit, redirect to login, or expose only a partial followers
preview. In particular, Instagram may warn that only the profile owner can see
all followers; that warning is kept with the source and the collected preview
must not be treated as the full audience.

DOM inspection and automated tests are non-state-changing. Explicit
authorization immediately before a live action, naming the exact Instagram
handle and intended operation (**Follow** or **Unfollow**), is an external
operator procedure. It is not a runtime confirmation or authorization gate in
the extension. Never infer that procedure from a source scrape, selector
inspection, a prior plan, or general permission to use the extension. After an
authorized action, verify the final relationship state in Instagram and the
single corresponding local candidate/history transition before allowing any
subsequent action.

## Verification boundary

`npm test` covers the local model, storage, engine controls and alarms,
side-panel protocol, follower collection, and relationship-action safeguards.
It uses test doubles and does not require an Instagram session or make a live
Follow/Unfollow click. An authenticated UI smoke test is a separate, manual
procedure that follows the external operator authorization procedure above.
