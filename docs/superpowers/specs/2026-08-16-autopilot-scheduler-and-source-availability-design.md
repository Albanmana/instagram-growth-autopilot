# Autopilot Scheduler and Source Availability Design

## Goal

Prevent a deferred source collection from starving due unfollows, and distinguish an unavailable Instagram source from a followers-trigger discovery failure.

## Scheduling invariant

The persisted `nextWorkAt` value and the Chrome alarm always represent the next executable global-lane operation. A due unfollow has priority over a balanced-cycle collection that is waiting for a retry. A collection retry remains persisted, but it may not repeatedly schedule an immediate wake while a due action is waiting.

The side panel may show `Ready` only for work that the engine can execute now. If an operation is delayed, it must expose its persisted deadline and the associated alarm state.

## Source availability contract

The injected followers-modal probe checks Instagram's rendered page for the known unavailable-profile state before searching for a followers trigger. It returns a structured terminal classification rather than the generic missing-trigger error.

The engine stores this as source status `unavailable`, clears any source-scan retry intent, and continues other eligible work. It preserves candidates and history. The Sources UI keeps the source visible with an explanatory message; an operator can use the existing Scan now control to retry it deliberately after fixing the handle.

Transient collection failures remain `error` and continue to use the existing retry cadence.

## Verification

Regression tests prove: (1) a due unfollow preempts a deferred balanced collection and leaves a future collection retry alarm, (2) unavailable-profile DOM is classified before trigger polling, (3) the engine persists the terminal status and continues the cycle, and (4) the side panel presents a deferred action as scheduled rather than falsely ready. The complete unit suite and the no-Instagram-activity Playwright extension E2E must pass after reloading the unpacked extension in Chrome.
