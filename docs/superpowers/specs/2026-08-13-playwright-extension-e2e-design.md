# Playwright Extension E2E Design

## Goal

Add a repeatable boot check for the unpacked Instagram Follow-Up extension,
then use a separate persistent Chromium profile for real Instagram end-to-end
testing only after its user is signed in and the operator has authorized it.

## Test environments

### Extension boot check

- Install Playwright as a development dependency.
- Launch Chromium with `extension/` loaded as an unpacked Manifest V3 extension.
- Verify that the service worker and side panel load from the unpacked
  extension and that the runtime state request succeeds.
- It does not navigate to, imitate, intercept, or replace Instagram.

### Live smoke test

- Launch a separate persistent Chromium user-data directory with the same
  unpacked extension, never the user's active Chrome profile.
- If Instagram requires authentication, pause and ask the user to complete the
  login themselves in that isolated browser window.
- Set the extension's per-source limit, run `Scrape + Follow`, and inspect the
  resulting visible Instagram row and local extension history.
- Each real relationship action requires immediate explicit operator
  authorization; do not run Auto or Unfollow as part of this check.

## Failure handling

- The E2E runner keeps Playwright traces and screenshots on failures.
- A boot-check failure is fixed through a regression test before code is
  changed.
- A live Instagram discrepancy is recorded with the observable page state and
  rechecked against the normal Instagram website after the fix.
- Login, challenge, CAPTCHA, or browser security interstitials are handed to
  the user; the runner never tries to bypass them.

## Scope

This adds test tooling only. It does not alter the live automation limits,
introduce a remote service, copy existing Chrome sessions, or store credentials
in the repository.
