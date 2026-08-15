# Live accelerated autopilot design

## Goal

Exercise the actual unpacked extension against the signed-in Instagram account with an existing source capped at ten candidates, while making calendar-based lifecycle checks observable in minutes rather than days.

## Chosen approach

The extension receives a development-only, opt-in live-test session. The session has an immutable ten-candidate source cap and a finite expiration. It uses the normal DOM collectors, Chrome tabs, relationship actions, local Supabase service, and browser session. There is no fixture, cloned Instagram page, mocked adapter, or simulated relationship action.

The virtual business clock advances seven days per real minute only for calendar eligibility: source scans, follow-back reviews, and J+2/J+7 eligibility. The global action lane and real wall-clock delays between Instagram interactions remain unchanged. A test session is refused unless the extension is unpacked/development-installed and connected to the local service.

## Lifecycle

1. The operator chooses an existing source. The test copies or constrains it to a limit of ten.
2. The normal engine collects visible followers and follows candidates through the existing Instagram adapter.
3. After each verified outcome, the existing durable candidate/history model is updated in local Supabase.
4. Calendar alarms are translated from the accelerated virtual clock to real Chrome alarm times. Action-safety alarms retain their normal wall-clock delay.
5. Follow-back reviews scrape the signed-in account's actual Followers list. Confirmed matches receive the existing J+7 state; unmatched records remain unknown and retry safely.
6. A stopped, expired, or recovery-required session schedules no further test work. The panel shows the active test state and all normal state remains exportable.

## Safety and acceptance

- No mode may make two Instagram interactions closer together than the configured action/batch delay.
- The test source never processes more than ten candidates.
- Tests cover time conversion, alarm classification, expiration, restart persistence, and the normal engine's action pacing.
- Live acceptance uses the real Instagram profile source and verifies the persisted Supabase history/state after every phase. A live follow-back confirmation is reported only if Instagram's actual followers list contains a tracked candidate; it is never fabricated.
