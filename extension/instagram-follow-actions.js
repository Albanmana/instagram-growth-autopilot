export async function performInstagramRelationshipAction({ expectedHandle, action, actionContext } = {}) {
  const FOLLOW_LABELS = new Set(["follow", "follow back", "suivre", "suivre en retour"]);
  const FOLLOWING_LABELS = new Set(["following", "suivi(e)", "suivi", "suivie"]);
  const REQUESTED_LABELS = new Set(["requested", "demandé", "demandee", "demande"]);
  const UNFOLLOW_LABELS = new Set(["unfollow", "ne plus suivre"]);
  const MAX_ROW_ANCESTORS = 8;
  const WAIT_ATTEMPTS = 40;
  const WAIT_INTERVAL_MS = 250;

  const at = () => new Date().toISOString();
  const succeeded = () => ({ status: "succeeded", at: at() });
  const followRequestSent = () => ({ status: "follow_request_sent", at: at() });
  const skipped = (reason) => ({ status: "skipped", reason, at: at() });
  const failed = (reason) => ({ status: "failed", reason, at: at() });
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const normalizeLabel = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const elementLabel = (element) => normalizeLabel(
    element?.textContent || element?.getAttribute?.("aria-label") || "",
  );
  const elementHasLabel = (element, labels) => {
    if (labels.has(elementLabel(element))) return true;
    return Array.from(element?.querySelectorAll?.("*") || []).some((child) => {
      return labels.has(elementLabel(child));
    });
  };
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement) || element.isConnected === false) return false;
    let ancestor = element;
    while (ancestor) {
      if (
        ancestor.isConnected === false ||
        ancestor.hidden === true ||
        ancestor.getAttribute?.("hidden") != null ||
        normalizeLabel(ancestor.getAttribute?.("aria-hidden")) === "true"
      ) return false;
      if (typeof getComputedStyle === "function") {
        const style = getComputedStyle(ancestor);
        if (
          style?.display === "none" ||
          style?.visibility === "hidden" ||
          style?.visibility === "collapse" ||
          style?.contentVisibility === "hidden" ||
          style?.opacity === "0"
        ) return false;
      }
      ancestor = ancestor.parentElement;
    }
    const rectangle = element.getBoundingClientRect();
    return rectangle.width > 0 && rectangle.height > 0;
  };
  const controlsWithin = (root) => Array.from(root?.querySelectorAll?.("button, [role='button']") || []);
  const findVisibleControl = (root, labels, accept = () => true) => controlsWithin(root).find((element) => {
    return isVisible(element) && elementHasLabel(element, labels) && accept(element);
  }) || null;
  const visibleControlBounds = (control) => {
    if (!isVisible(control)) return null;
    const bounds = control.getBoundingClientRect();
    return [bounds?.top, bounds?.left, bounds?.width, bounds?.height].every(Number.isFinite)
      ? bounds
      : null;
  };
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
      const value = predicate();
      if (value) return value;
      await delay(WAIT_INTERVAL_MS);
    }
    return null;
  };
  const isCanonicalHandle = (value) => {
    return typeof value === "string" && /^[a-z0-9._]{1,30}$/i.test(value);
  };
  const pathnameMatchesHandle = (pathname, handle) => {
    return typeof pathname === "string" && pathname.toLowerCase() === `/${handle.toLowerCase()}/`;
  };
  const canonicalProfileHandle = (href) => {
    const value = String(href || "");
    let pathname = value;
    if (/^https?:\/\//i.test(value)) {
      try {
        const parsed = new URL(value);
        if (parsed.hostname.replace(/^www\./i, "").toLowerCase() !== "instagram.com") return null;
        pathname = parsed.pathname;
      } catch {
        return null;
      }
    } else {
      pathname = value.split(/[?#]/, 1)[0];
    }
    const segments = pathname.split("/").filter(Boolean);
    return segments.length === 1 && isCanonicalHandle(segments[0])
      ? segments[0].toLowerCase()
      : null;
  };
  const hrefMatchesHandle = (href, handle) => canonicalProfileHandle(href) === handle.toLowerCase();
  const recoveryIntentId = () => {
    if (!actionContext || typeof actionContext !== "object") return null;
    if (actionContext.recoveringPersistedIntent !== true) return null;
    if (actionContext.action !== action) return null;
    if (String(actionContext.expectedHandle || "").toLowerCase() !== expectedHandle.toLowerCase()) return null;
    if (actionContext.candidateId !== `instagram:${expectedHandle.toLowerCase()}`) return null;
    return typeof actionContext.intentId === "string" && actionContext.intentId
      ? actionContext.intentId
      : null;
  };
  const alreadyDesired = (reason) => {
    const result = { ...skipped(reason), code: "already_desired" };
    const intentId = recoveryIntentId();
    if (intentId) result.intentId = intentId;
    return result;
  };
  const hasAncestor = (element, predicate) => {
    let ancestor = element?.parentElement;
    while (ancestor) {
      if (predicate(ancestor)) return true;
      ancestor = ancestor.parentElement;
    }
    return false;
  };
  const isInsideVisibleDialog = (element) => hasAncestor(element, (ancestor) => {
    return ancestor.getAttribute?.("role") === "dialog" && isVisible(ancestor);
  });
  const isMountedInsideDialog = (element) => {
    return element?.isConnected !== false && hasAncestor(element, (ancestor) => {
      return ancestor.isConnected !== false && ancestor.getAttribute?.("role") === "dialog";
    });
  };
  const closestVisibleDialog = (element) => {
    let ancestor = element?.parentElement;
    while (ancestor) {
      if (ancestor.getAttribute?.("role") === "dialog") {
        return isVisible(ancestor) ? ancestor : null;
      }
      ancestor = ancestor.parentElement;
    }
    return null;
  };
  const dialogElements = () => Array.from(
    document.querySelectorAll("div[role='dialog'], section[role='dialog']"),
  );
  const visibleDialogs = () => dialogElements().filter(isVisible);
  const snapshotConfirmations = () => {
    const dialogs = dialogElements();
    return {
      dialogs: new Set(dialogs),
      controls: new Set(dialogs.flatMap((dialog) => {
        return controlsWithin(dialog).filter((control) => elementHasLabel(control, UNFOLLOW_LABELS));
      })),
    };
  };
  const findActionConfirmationControl = (snapshot) => {
    const dialogs = visibleDialogs();
    const topmostDialog = dialogs[dialogs.length - 1];
    if (!topmostDialog || snapshot.dialogs.has(topmostDialog)) return null;
    return findVisibleControl(topmostDialog, UNFOLLOW_LABELS, (control) => {
      return !snapshot.controls.has(control);
    });
  };
  const findProfileHeaderControl = (labels) => {
    for (const header of Array.from(document.querySelectorAll("header")).filter(isVisible)) {
      const insideMain = hasAncestor(header, (ancestor) => ancestor.tagName === "MAIN" && isVisible(ancestor));
      const insideExcludedChrome = hasAncestor(header, (ancestor) => {
        return ancestor.tagName === "NAV" ||
          ancestor.tagName === "ASIDE" ||
          ancestor.getAttribute?.("role") === "dialog";
      });
      if (!insideMain || insideExcludedChrome) continue;
      const control = findVisibleControl(header, labels, (candidate) => {
        let ancestor = candidate.parentElement;
        while (ancestor && ancestor !== header) {
          if (
            ancestor.tagName === "NAV" ||
            ancestor.tagName === "ASIDE" ||
            ancestor.getAttribute?.("role") === "dialog"
          ) return false;
          ancestor = ancestor.parentElement;
        }
        return ancestor === header;
      });
      if (control) return control;
    }

    const targetScopedControls = new Set();
    const targetAnchors = Array.from(document.querySelectorAll("a[href]")).filter((anchor) => {
      return isVisible(anchor) &&
        hrefMatchesHandle(anchor.getAttribute("href"), expectedHandle) &&
        !hasAncestor(anchor, (ancestor) => {
          return ancestor.tagName === "NAV" ||
            ancestor.tagName === "ASIDE" ||
            ancestor.getAttribute?.("role") === "dialog";
        });
    });
    for (const anchor of targetAnchors) {
      let scope = anchor.parentElement;
      while (scope) {
        const scopeProfiles = Array.from(scope.querySelectorAll?.("a[href]") || []).filter((candidate) => {
          return isVisible(candidate) && canonicalProfileHandle(candidate.getAttribute("href")) != null;
        });
        const isTargetOnlyScope = scopeProfiles.length > 0 && scopeProfiles.every((candidate) => {
          return hrefMatchesHandle(candidate.getAttribute("href"), expectedHandle);
        });
        if (isTargetOnlyScope) {
          const controls = controlsWithin(scope).filter((control) => {
            return isVisible(control) && elementHasLabel(control, labels) && !hasAncestor(control, (ancestor) => {
              return ancestor.tagName === "NAV" ||
                ancestor.tagName === "ASIDE" ||
                ancestor.getAttribute?.("role") === "dialog";
            });
          });
          if (controls.length === 1) targetScopedControls.add(controls[0]);
        }
        if (scope.tagName === "MAIN") break;
        scope = scope.parentElement;
      }
    }
    if (targetScopedControls.size === 1) return [...targetScopedControls][0];

    const profileMainControls = new Set();
    const profileRoots = Array.from(document.querySelectorAll("main")).filter(isVisible);
    if (profileRoots.length === 0 && document.body && isVisible(document.body)) profileRoots.push(document.body);
    for (const main of profileRoots) {
      for (const control of controlsWithin(main)) {
        if (!isVisible(control) || !elementHasLabel(control, labels)) continue;
        const insideExcludedChrome = hasAncestor(control, (ancestor) => {
          return ancestor.tagName === "NAV" ||
            ancestor.tagName === "ASIDE" ||
            ancestor.getAttribute?.("role") === "dialog";
        });
        if (!insideExcludedChrome) profileMainControls.add(control);
      }
    }
    if (profileMainControls.size === 1) return [...profileMainControls][0];
    const controlsByVerticalPosition = [...profileMainControls]
      .map((control) => ({ control, bounds: visibleControlBounds(control) }))
      .filter(({ bounds }) => bounds != null)
      .sort((left, right) => left.bounds.top - right.bounds.top);
    if (controlsByVerticalPosition.length > 1) {
      const [first, second] = controlsByVerticalPosition;
      if (second.bounds.top - first.bounds.top >= 96) return first.control;
    }
    return null;
  };
  const visibleProfileControlDiagnostics = () => {
    const controls = new Set();
    const profileRoots = Array.from(document.querySelectorAll("main")).filter(isVisible);
    if (profileRoots.length === 0 && document.body && isVisible(document.body)) profileRoots.push(document.body);
    for (const root of profileRoots) {
      for (const control of controlsWithin(root)) {
        if (!isVisible(control) || hasAncestor(control, (ancestor) => {
          return ancestor.tagName === "NAV" ||
            ancestor.tagName === "ASIDE" ||
            ancestor.getAttribute?.("role") === "dialog";
        })) continue;
        controls.add(control);
      }
    }
    return [...controls].slice(0, 12).map((control) => {
      const bounds = visibleControlBounds(control);
      return {
        tag: control.tagName?.toLowerCase() || "unknown",
        label: elementLabel(control).slice(0, 120),
        top: bounds?.top ?? null,
        left: bounds?.left ?? null,
      };
    });
  };
  const missingProfileControl = (reason) => {
    return failed(`${reason} Visible profile controls: ${JSON.stringify(visibleProfileControlDiagnostics())}.`);
  };
  const profileStateIs = (labels) => Boolean(findProfileHeaderControl(labels));
  const replacementProfileControlAt = (labels, expectedBounds) => {
    if (!expectedBounds) return null;
    const matches = [];
    const profileRoots = Array.from(document.querySelectorAll("main")).filter(isVisible);
    if (profileRoots.length === 0 && document.body && isVisible(document.body)) profileRoots.push(document.body);
    for (const root of profileRoots) {
      for (const control of controlsWithin(root)) {
        if (!isVisible(control) || !elementHasLabel(control, labels)) continue;
        if (hasAncestor(control, (ancestor) => {
          return ancestor.tagName === "NAV" ||
            ancestor.tagName === "ASIDE" ||
            ancestor.getAttribute?.("role") === "dialog";
        })) continue;
        const bounds = visibleControlBounds(control);
        if (!bounds || Math.abs(bounds.top - expectedBounds.top) > 48 || Math.abs(bounds.left - expectedBounds.left) > 48) continue;
        matches.push(control);
      }
    }
    return matches.length === 1 ? matches[0] : null;
  };
  const clickedProfileControlReachedState = (control, labels, originalPathname, {
    allowReplacement = false,
    replacementBounds = null,
  } = {}) => {
    if (location.pathname !== originalPathname) return false;
    if (isVisible(control) && elementHasLabel(control, labels)) return true;
    return allowReplacement && (
      profileStateIs(labels) ||
      replacementProfileControlAt(labels, replacementBounds) != null
    );
  };
  const findFollowingListRow = (handle) => {
    const anchors = Array.from(document.querySelectorAll("a[href]")).filter((anchor) => {
      return isVisible(anchor) &&
        isInsideVisibleDialog(anchor) &&
        hrefMatchesHandle(anchor.getAttribute("href"), handle);
    });

    for (const anchor of anchors) {
      const dialog = closestVisibleDialog(anchor);
      if (!dialog) continue;
      let ancestor = anchor.parentElement;
      for (let depth = 1; ancestor && depth <= MAX_ROW_ANCESTORS; depth += 1) {
        if (ancestor.getAttribute?.("role") === "dialog") break;
        const parentProfileLinks = Array.from(ancestor.parentElement?.querySelectorAll?.("a[href]") || []).filter((candidate) => {
          return isVisible(candidate) && canonicalProfileHandle(candidate.getAttribute("href")) != null;
        });
        const hasSiblingProfile = parentProfileLinks.some((candidate) => {
          return canonicalProfileHandle(candidate.getAttribute("href")) !== handle.toLowerCase() &&
            !hasAncestor(candidate, (parent) => parent === ancestor);
        });
        if (hasSiblingProfile) {
          const followingControl = findVisibleControl(ancestor, FOLLOWING_LABELS);
          if (followingControl) return { row: ancestor, control: followingControl, state: "following" };
          const followControl = findVisibleControl(ancestor, FOLLOW_LABELS);
          if (followControl) return { row: ancestor, control: followControl, state: "follow" };
          break;
        }
        ancestor = ancestor.parentElement;
      }
    }

    return anchors.length > 0 ? { state: "control-missing" } : null;
  };
  const targetProfileIsMountedInDialog = (handle) => {
    return Array.from(document.querySelectorAll("a[href]")).some((anchor) => {
      return isMountedInsideDialog(anchor) && hrefMatchesHandle(anchor.getAttribute("href"), handle);
    });
  };
  const confirmUnfollow = async (snapshot) => {
    const confirmationControl = await waitFor(() => findActionConfirmationControl(snapshot));
    if (!confirmationControl) return false;
    confirmationControl.click();
    return true;
  };
  const waitForFollowingListUnfollowState = async (handle, originalControl, originalPathname) => {
    let targetStayedAbsent = true;
    for (let attempt = 0; attempt <= WAIT_ATTEMPTS; attempt += 1) {
      if (location.pathname !== originalPathname) {
        targetStayedAbsent = false;
      } else {
        if (isVisible(originalControl) && elementHasLabel(originalControl, FOLLOW_LABELS)) return true;
        const currentRow = findFollowingListRow(handle);
        if (currentRow?.state === "follow") return true;
        if (targetProfileIsMountedInDialog(handle)) targetStayedAbsent = false;
      }
      if (attempt < WAIT_ATTEMPTS) await delay(WAIT_INTERVAL_MS);
    }
    return targetStayedAbsent;
  };

  if (action !== "follow" && action !== "unfollow") {
    return failed("Instagram relationship action must be exactly follow or unfollow.");
  }
  if (!isCanonicalHandle(expectedHandle)) {
    return failed("The queued Instagram handle is invalid.");
  }

  const onExpectedProfile = pathnameMatchesHandle(location.pathname, expectedHandle);
  if (onExpectedProfile) {
    const originalPathname = location.pathname;
    const initialProfileControl = await waitFor(() => {
      const followingControl = findProfileHeaderControl(FOLLOWING_LABELS);
      if (followingControl) return { control: followingControl, state: "following" };
      const requestedControl = findProfileHeaderControl(REQUESTED_LABELS);
      if (requestedControl) return { control: requestedControl, state: "requested" };
      const followControl = findProfileHeaderControl(FOLLOW_LABELS);
      if (followControl) return { control: followControl, state: "follow" };
      return null;
    });
    if (action === "follow") {
      if (initialProfileControl?.state === "following") {
        return alreadyDesired("The Instagram profile is already followed.");
      }
      if (initialProfileControl?.state === "requested") {
        return alreadyDesired("The Instagram profile already has a pending follow request.");
      }

      const followControl = initialProfileControl?.state === "follow"
        ? initialProfileControl.control
        : null;
      if (!followControl) {
        return missingProfileControl("Instagram follow control was not found in the visible profile header.");
      }

      followControl.click();
      const confirmed = await waitFor(() => {
        if (clickedProfileControlReachedState(followControl, FOLLOWING_LABELS, originalPathname)) return "followed";
        if (clickedProfileControlReachedState(followControl, REQUESTED_LABELS, originalPathname)) return "requested";
        return null;
      });
      if (confirmed === "followed") return succeeded();
      if (confirmed === "requested") return followRequestSent();
      return failed("Instagram did not confirm the new follow state.");
    }

    if (initialProfileControl?.state === "follow") {
      return alreadyDesired("The Instagram profile is already unfollowed.");
    }

    const followingControl = ["following", "requested"].includes(initialProfileControl?.state)
      ? initialProfileControl.control
      : null;
    if (!followingControl) {
      return missingProfileControl("Instagram following control was not found in the visible profile header.");
    }

    const confirmationSnapshot = snapshotConfirmations();
    const followingControlBounds = visibleControlBounds(followingControl);
    followingControl.click();
    if (!await confirmUnfollow(confirmationSnapshot)) {
      return failed("Instagram unfollow confirmation control was not found.");
    }
    const confirmed = await waitFor(() => {
      return clickedProfileControlReachedState(followingControl, FOLLOW_LABELS, originalPathname, {
        allowReplacement: true,
        replacementBounds: followingControlBounds,
      });
    });
    return confirmed
      ? succeeded()
      : failed("Instagram did not confirm the new unfollow state.");
  }

  if (action === "follow") {
    return skipped("The loaded profile does not match the queued handle.");
  }

  if (!/^\/[a-z0-9._]{1,30}\/following\/$/i.test(location.pathname)) {
    return skipped("The loaded page is not an Instagram Following-list route.");
  }

  const listRow = findFollowingListRow(expectedHandle);
  if (!listRow) {
    return skipped("The loaded profile does not match the queued handle, and its Following-list row was not found.");
  }
  if (listRow.state === "control-missing") {
    return failed("Instagram relationship control was not found within the target Following-list row.");
  }
  if (listRow.state === "follow") {
    return alreadyDesired("The Instagram Following-list row is already unfollowed.");
  }

  const originalControl = listRow.control;
  const originalPathname = location.pathname;
  const confirmationSnapshot = snapshotConfirmations();
  originalControl.click();
  if (!await confirmUnfollow(confirmationSnapshot)) {
    return failed("Instagram unfollow confirmation control was not found.");
  }

  const confirmed = await waitForFollowingListUnfollowState(expectedHandle, originalControl, originalPathname);
  return confirmed
    ? succeeded()
    : failed("Instagram did not confirm the Following-list row as unfollowed.");
}
