import { normalizeSourceInput } from "./followup-model.js";

export function normalizeInstagramProfileTarget(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    throw new Error("Profile URL or handle is required.");
  }
  return normalizeSourceInput(value);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("Follower collection was aborted.", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => undefined);
    throw abortError(signal);
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function openProfileListModal(
  executeScript,
  tabId,
  sourceType = "followers",
  expectedProfileUrl,
) {
  const [result] = await executeScript({
    target: { tabId },
    args: [sourceType, expectedProfileUrl],
    func: async (activeSourceType, canonicalProfileUrl) => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalize = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const sourceHandleFromCanonicalUrl = (value) => {
        try {
          const parsed = new URL(String(value || ""));
          const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
          const segments = parsed.pathname.split("/").filter(Boolean);
          if (
            parsed.protocol !== "https:" ||
            hostname !== "instagram.com" ||
            segments.length !== 1 ||
            !/^[a-z0-9._]{1,30}$/i.test(segments[0])
          ) {
            return null;
          }
          return segments[0].toLowerCase();
        } catch {
          return null;
        }
      };
      const routeSegments = (value) => String(value || "").split("/").filter(Boolean);
      const isBoundRoute = (pathname, expectedHandle) => {
        const segments = routeSegments(pathname);
        if (segments[0]?.toLowerCase() !== expectedHandle) return false;
        if (segments.length === 1) return true;
        if (segments.length === 2) return segments[1].toLowerCase() === activeSourceType;
        return (
          activeSourceType === "followers" &&
          segments.length === 3 &&
          segments[1].toLowerCase() === "followers" &&
          segments[2].toLowerCase() === "mutualfirst"
        );
      };
      const triggerMatchesSource = (anchor, expectedHandle) => {
        const href = anchor.getAttribute("href") || "";
        try {
          const parsed = new URL(href, window.location.origin);
          const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
          const segments = routeSegments(parsed.pathname);
          return (
            parsed.protocol === "https:" &&
            hostname === "instagram.com" &&
            segments.length === 2 &&
            segments[0].toLowerCase() === expectedHandle &&
            segments[1].toLowerCase() === activeSourceType
          );
        } catch {
          return false;
        }
      };
      const triggerTextMatchesSourceType = (candidate) => {
        const label = normalize(
          candidate.textContent || candidate.getAttribute("aria-label") || candidate.getAttribute("title") || "",
        );
        if (!label) return false;
        return activeSourceType === "followers"
          ? /\bfollowers?\b|abonn|suiveur/i.test(label)
          : /\bfollowing\b|abonnement|suivi|followed/i.test(label);
      };

      const expectedHandle = sourceHandleFromCanonicalUrl(canonicalProfileUrl);
      if (!expectedHandle) {
        return { error: "The expected source profile identity is not canonical." };
      }
      if (!isBoundRoute(window.location.pathname, expectedHandle) || routeSegments(window.location.pathname).length !== 1) {
        return { error: "The loaded Instagram profile does not match the expected source." };
      }

      const dialogSelector = "div[role='dialog'], section[role='dialog']";
      const dialogsBeforeClick = new Set(document.querySelectorAll(dialogSelector));
      if (Array.from(dialogsBeforeClick).some(isVisible)) {
        return { error: "A pre-existing Instagram dialog is already open; refusing to click the followers trigger." };
      }

      let trigger = null;
      const startedAt = Date.now();
      while (!trigger && Date.now() - startedAt < 15000) {
        const canonicalTriggers = Array.from(document.querySelectorAll("a[href]")).filter((anchor) => {
          return (
            isVisible(anchor) &&
            triggerMatchesSource(anchor, expectedHandle)
          );
        });
        if (canonicalTriggers.length > 1) {
          return { error: `The ${activeSourceType} trigger is ambiguous for the expected source profile.` };
        }
        [trigger] = canonicalTriggers;
        if (!trigger) {
          const textTriggers = Array.from(
            document.querySelectorAll("a, button, span[role='link'], div[role='button']"),
          ).filter((candidate) => isVisible(candidate) && triggerTextMatchesSourceType(candidate));
          if (textTriggers.length > 1) {
            return { error: `The visible ${activeSourceType} text controls are ambiguous for the expected source profile.` };
          }
          [trigger] = textTriggers;
        }
        if (!trigger) await delay(300);
      }

      if (!trigger) {
        return { error: `Could not find the ${activeSourceType} trigger on the profile.` };
      }

      trigger.click();

      const modalStartedAt = Date.now();
      while (Date.now() - modalStartedAt < 10000) {
        if (!isBoundRoute(window.location.pathname, expectedHandle)) {
          return { error: `The ${activeSourceType} trigger navigated away from the expected source profile.` };
        }

        const openedDialogs = Array.from(document.querySelectorAll(dialogSelector)).filter((dialog) => {
          return !dialogsBeforeClick.has(dialog) && isVisible(dialog);
        });
        if (openedDialogs.length > 1) {
          return { error: `Multiple newly opened dialogs made the ${activeSourceType} result ambiguous.` };
        }
        if (openedDialogs.length === 1) {
          const dialogToken = `${activeSourceType}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          openedDialogs[0].setAttribute("data-instagram-followup-dialog", dialogToken);
          return { ok: true, dialogToken };
        }
        await delay(250);
      }

      return {
        error: `The ${activeSourceType} modal did not open after clicking trigger (href=${trigger.getAttribute("href")}, text="${trigger.textContent?.trim().slice(0, 40)}").`,
      };
    },
  });

  if (result?.error) {
    throw new Error(result.error.message ?? JSON.stringify(result.error));
  }
  if (result?.result?.error) {
    throw new Error(result.result.error);
  }
  if (!result?.result?.dialogToken) {
    throw new Error(`The ${sourceType} script returned no bound dialog token.`);
  }
  return result.result;
}

async function expandFollowersModalIfNeeded(
  executeScript,
  tabId,
  expectedProfileUrl,
  dialogToken,
) {
  const [result] = await executeScript({
    target: { tabId },
    args: [expectedProfileUrl, dialogToken],
    func: async (canonicalProfileUrl, boundDialogToken) => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalize = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const pathSegments = (value) => String(value || "").split("/").filter(Boolean);
      const sourceHandleFromCanonicalUrl = (value) => {
        try {
          const parsed = new URL(String(value || ""));
          const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
          const segments = pathSegments(parsed.pathname);
          if (
            parsed.protocol !== "https:" ||
            hostname !== "instagram.com" ||
            segments.length !== 1 ||
            !/^[a-z0-9._]{1,30}$/i.test(segments[0])
          ) {
            return null;
          }
          return segments[0].toLowerCase();
        } catch {
          return null;
        }
      };
      const isBoundRoute = (pathname, expectedHandle) => {
        const segments = pathSegments(pathname);
        return (
          segments[0]?.toLowerCase() === expectedHandle &&
          (
            segments.length === 1 ||
            (segments.length === 2 && segments[1].toLowerCase() === "followers") ||
            (
              segments.length === 3 &&
              segments[1].toLowerCase() === "followers" &&
              segments[2].toLowerCase() === "mutualfirst"
            )
          )
        );
      };
      const profileHandleFromHref = (href) => {
        try {
          const parsed = new URL(String(href || ""), window.location.origin);
          const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
          const segments = pathSegments(parsed.pathname);
          if (
            parsed.protocol !== "https:" ||
            hostname !== "instagram.com" ||
            segments.length !== 1 ||
            !/^[a-z0-9._]{1,30}$/i.test(segments[0])
          ) {
            return null;
          }
          return segments[0].toLowerCase();
        } catch {
          return null;
        }
      };
      const countProfileAnchors = (dialog) => {
        if (!(dialog instanceof HTMLElement)) return 0;
        return Array.from(dialog.querySelectorAll("a[href]")).filter((anchor) => {
          return isVisible(anchor) && profileHandleFromHref(anchor.getAttribute("href") || anchor.href);
        }).length;
      };
      const findExpandTrigger = (dialog, expectedHandle) => {
        if (!(dialog instanceof HTMLElement)) return null;

        const anchors = Array.from(dialog.querySelectorAll("a[href]"));
        const byHref = anchors.find((anchor) => {
          const href = anchor.getAttribute("href") || anchor.href || "";
          if (!isVisible(anchor)) return false;
          try {
            const parsed = new URL(href, window.location.origin);
            const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
            const segments = pathSegments(parsed.pathname);
            return (
              parsed.protocol === "https:" &&
              hostname === "instagram.com" &&
              segments.length === 3 &&
              segments[0].toLowerCase() === expectedHandle &&
              segments[1].toLowerCase() === "followers" &&
              segments[2].toLowerCase() === "mutualfirst"
            );
          } catch {
            return false;
          }
        });
        if (byHref) return byHref;

        return Array.from(dialog.querySelectorAll("a, button, span[role='link'], div[role='button']")).find((candidate) => {
          const label = normalize(candidate.textContent || candidate.getAttribute("aria-label") || "");
          return isVisible(candidate) && label.includes("all followers");
        }) || null;
      };

      const expectedHandle = sourceHandleFromCanonicalUrl(canonicalProfileUrl);
      if (!expectedHandle || !boundDialogToken) {
        return { error: "Followers modal binding is missing its canonical source identity." };
      }
      if (!isBoundRoute(window.location.pathname, expectedHandle)) {
        return { error: "The open followers modal is not on the expected source route." };
      }

      const dialogSelector = "div[role='dialog'], section[role='dialog']";
      const findBoundDialogs = () => Array.from(document.querySelectorAll(dialogSelector)).filter((candidate) => {
        return (
          isVisible(candidate) &&
          candidate.getAttribute("data-instagram-followup-dialog") === boundDialogToken
        );
      });
      const initialBoundDialogs = findBoundDialogs();
      if (initialBoundDialogs.length !== 1) {
        return { error: initialBoundDialogs.length > 1
          ? "The bound followers modal is ambiguous."
          : "The bound followers modal is not open." };
      }
      let dialog = initialBoundDialogs[0];

      await delay(1200);
      const expandTrigger = findExpandTrigger(dialog, expectedHandle);
      if (!expandTrigger) {
        return {
          expanded: false,
          beforeCount: countProfileAnchors(dialog),
          afterCount: countProfileAnchors(dialog),
          reason: "expand-trigger-not-found",
        };
      }

      const beforeCount = countProfileAnchors(dialog);
      const previousUrl = window.location.pathname;
      const dialogsBeforeExpand = new Set(document.querySelectorAll(dialogSelector));
      expandTrigger.click();

      const expandedStartedAt = Date.now();
      while (Date.now() - expandedStartedAt < 10000) {
        if (!isBoundRoute(window.location.pathname, expectedHandle)) {
          return { error: "Expanding followers navigated away from the expected source route." };
        }

        const replacementDialogs = Array.from(document.querySelectorAll(dialogSelector)).filter((candidate) => {
          return !dialogsBeforeExpand.has(candidate) && isVisible(candidate);
        });
        if (replacementDialogs.length > 1) {
          return { error: "Multiple new dialogs made the expanded followers modal ambiguous." };
        }
        if (replacementDialogs.length === 1) {
          dialog.removeAttribute("data-instagram-followup-dialog");
          dialog = replacementDialogs[0];
          dialog.setAttribute("data-instagram-followup-dialog", boundDialogToken);
        } else {
          const boundDialogs = findBoundDialogs();
          if (boundDialogs.length > 1) {
            return { error: "The expanded followers modal binding is ambiguous." };
          }
          if (boundDialogs.length === 1) dialog = boundDialogs[0];
        }

        if (!dialog || !isVisible(dialog)) {
          await delay(250);
          continue;
        }

        const afterCount = countProfileAnchors(dialog);
        const currentPath = window.location.pathname;
        const expandStillVisible = findExpandTrigger(dialog, expectedHandle);
        const currentSegments = pathSegments(currentPath);
        const movedToFullList = (
          currentSegments.length === 3 &&
          currentSegments[0].toLowerCase() === expectedHandle &&
          currentSegments[1].toLowerCase() === "followers" &&
          currentSegments[2].toLowerCase() === "mutualfirst" &&
          currentPath !== previousUrl
        );
        const listGrew = afterCount > beforeCount;

        if (movedToFullList || listGrew || !expandStillVisible) {
          await delay(800);
          return {
            expanded: true,
            beforeCount,
            afterCount: countProfileAnchors(dialog),
            previousPath: previousUrl,
            currentPath,
          };
        }

        await delay(250);
      }

      return {
        expanded: true,
        beforeCount,
        afterCount: countProfileAnchors(dialog),
        previousPath: previousUrl,
        currentPath: window.location.pathname,
        timedOut: true,
      };
    },
  });

  if (result?.error) {
    throw new Error(result.error.message ?? JSON.stringify(result.error));
  }
  if (result?.result?.error) {
    throw new Error(result.result.error);
  }
  return result?.result ?? { expanded: false, reason: "no-result" };
}

export async function collectProfileListFromDom(
  executeScript,
  tabId,
  sourceType,
  limit,
  log,
  expectedProfileUrl,
  dialogToken,
) {
  const [result] = await executeScript({
    target: { tabId },
    args: [sourceType, limit, expectedProfileUrl, dialogToken],
    func: async (activeSourceType, maxLeads, canonicalProfileUrl, boundDialogToken) => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const pathSegments = (value) => String(value || "").split("/").filter(Boolean);
      const reservedProfileRoutes = new Set([
        "about",
        "accounts",
        "api",
        "challenge",
        "developer",
        "direct",
        "emails",
        "explore",
        "legal",
        "oauth",
        "p",
        "privacy",
        "reel",
        "reels",
        "settings",
        "stories",
        "terms",
        "tv",
        "web",
      ]);
      const sourceHandleFromCanonicalUrl = (value) => {
        try {
          const parsed = new URL(String(value || ""));
          const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
          const segments = pathSegments(parsed.pathname);
          if (
            parsed.protocol !== "https:" ||
            hostname !== "instagram.com" ||
            segments.length !== 1 ||
            !/^[a-z0-9._]{1,30}$/i.test(segments[0])
          ) {
            return null;
          }
          return segments[0].toLowerCase();
        } catch {
          return null;
        }
      };
      const isBoundRoute = (pathname, expectedHandle) => {
        const segments = pathSegments(pathname);
        return (
          segments[0]?.toLowerCase() === expectedHandle &&
          (
            segments.length === 1 ||
            (segments.length === 2 && segments[1].toLowerCase() === activeSourceType) ||
            (
              activeSourceType === "followers" &&
              segments.length === 3 &&
              segments[1].toLowerCase() === "followers" &&
              segments[2].toLowerCase() === "mutualfirst"
            )
          )
        );
      };
      const getUsernameFromHref = (href) => {
        const value = String(href || "").trim();
        if (!value || (!value.startsWith("/") && !/^https:\/\//i.test(value))) return "";
        try {
          const parsed = new URL(value, window.location.origin);
          const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
          const segments = pathSegments(parsed.pathname);
          const username = segments[0] || "";
          if (
            parsed.protocol !== "https:" ||
            hostname !== "instagram.com" ||
            segments.length !== 1 ||
            !/^[a-z0-9._]{1,30}$/i.test(username) ||
            reservedProfileRoutes.has(username.toLowerCase())
          ) {
            return "";
          }
          return username.toLowerCase();
        } catch {
          return "";
        }
      };

      const expectedHandle = sourceHandleFromCanonicalUrl(canonicalProfileUrl);
      if (!expectedHandle || !boundDialogToken) {
        throw new Error(`${activeSourceType} modal binding is missing its canonical source identity.`);
      }
      if (!isBoundRoute(window.location.pathname, expectedHandle)) {
        throw new Error(`The ${activeSourceType} modal is not on the expected source route.`);
      }

      const dialogs = Array.from(
        document.querySelectorAll("div[role='dialog'], section[role='dialog']"),
      ).filter((candidate) => {
        return (
          isVisible(candidate) &&
          candidate.getAttribute("data-instagram-followup-dialog") === boundDialogToken
        );
      });
      if (dialogs.length !== 1) {
        throw new Error(dialogs.length > 1
          ? `The bound ${activeSourceType} modal is ambiguous.`
          : `The bound ${activeSourceType} modal is not open.`);
      }
      const [dialog] = dialogs;

      const limitationText = normalize(dialog.innerText || "");
      const ownerOnlyListNotice =
        activeSourceType === "followers" &&
        (
          /only\s+[^\n]{0,80}\s+can see all followers/i.test(limitationText) ||
          /seul(?:\(e\))?\s+[^\n]{0,80}\s+peut voir tous les followers/i.test(limitationText)
        );
      const othersSummaryMatch = limitationText.match(/\b(?:and|et)\s+([\d.,kmb\s]+)\s+others\b/i);

      const findListRoot = () => {
        const candidates = Array.from(dialog.querySelectorAll("*")).filter((element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(element);
          return /(auto|scroll)/i.test(style.overflowY) && element.scrollHeight > element.clientHeight + 50;
        });
        return (
          candidates.reverse().find((element) => element.querySelector("a[href]")) ||
          candidates[0] ||
          dialog
        );
      };

      const collected = new Map();
      let idlePasses = 0;
      let lastCount = 0;

      const isFollowerRowControl = (element) => {
        if (!isVisible(element)) return false;
        const label = normalize(element.textContent || element.getAttribute("aria-label") || "").toLowerCase();
        return /^(?:follow|following|follow back|remove|suivre|suivi(?:\(e\))?|suivre aussi|s'abonner|abonn[eé](?:\(e\))?|supprimer)$/.test(label);
      };
      const isInside = (element, ancestor) => {
        let current = element;
        while (current) {
          if (current === ancestor) return true;
          current = current.parentElement;
        }
        return false;
      };
      const findFollowerRow = (anchor, username) => {
        let candidate = anchor.parentElement;
        for (let depth = 0; candidate && candidate !== dialog && depth < 8; depth += 1) {
          const rowHandles = new Set(
            Array.from(candidate.querySelectorAll("a[href]"))
              .map((profileAnchor) => getUsernameFromHref(profileAnchor.getAttribute("href") || profileAnchor.href))
              .filter(Boolean),
          );
          const hasRelationshipControl = Array.from(
            candidate.querySelectorAll("button, [role='button']"),
          ).some(isFollowerRowControl);
          const showsUsername = [candidate, ...candidate.querySelectorAll("a, span, div")].some((element) => {
            return normalize(element.textContent).replace(/^@+/, "").toLowerCase() === username;
          });
          const isSemanticRow = (
            candidate.tagName === "LI" ||
            candidate.tagName === "ARTICLE" ||
            candidate.getAttribute("role") === "listitem"
          );
          const hasSiblingProfile = Array.from(
            candidate.parentElement?.querySelectorAll?.("a[href]") || [],
          ).some((profileAnchor) => {
            const siblingHandle = getUsernameFromHref(
              profileAnchor.getAttribute("href") || profileAnchor.href,
            );
            return (
              isVisible(profileAnchor) &&
              siblingHandle &&
              siblingHandle !== username &&
              !isInside(profileAnchor, candidate)
            );
          });
          if (
            rowHandles.size === 1 &&
            rowHandles.has(username) &&
            showsUsername &&
            (hasRelationshipControl || isSemanticRow || hasSiblingProfile)
          ) {
            return candidate;
          }
          candidate = candidate.parentElement;
        }
        return null;
      };

      const collectVisibleRows = () => {
        const anchors = Array.from(dialog.querySelectorAll("a[href]"))
          .filter((anchor) => isVisible(anchor) && getUsernameFromHref(anchor.getAttribute("href") || anchor.href));

        anchors.forEach((anchor) => {
          const username = getUsernameFromHref(anchor.getAttribute("href") || anchor.href);
          if (!username || collected.has(username)) return;

          const row = findFollowerRow(anchor, username);
          if (!row) return;
          const textNodes = row
            ? Array.from(row.querySelectorAll("span, div"))
                .map((node) => normalize(node.textContent))
                .filter(Boolean)
            : [];
          const name = textNodes.find((text) => {
            const normalizedText = text.toLowerCase();
            return (
              normalizedText !== username &&
              !/^(?:follow|following|follow back|remove|suivre|suivi(?:\(e\))?|suivre aussi|s'abonner|abonn[eé](?:\(e\))?|supprimer)$/.test(normalizedText)
            );
          }) || "";

          collected.set(username, {
            source_type: activeSourceType,
            username,
            name,
            profile_url: `https://www.instagram.com/${username}/`,
            comment_text: "",
            comment_date: "",
            post_url: "",
            is_verified: "",
          });
        });
      };

      collectVisibleRows();
      await delay(800);

      for (let step = 0; step < 80; step += 1) {
        collectVisibleRows();
        if (collected.size >= maxLeads) break;

        if (collected.size === lastCount) {
          idlePasses += 1;
        } else {
          idlePasses = 0;
          lastCount = collected.size;
        }

        if (idlePasses >= 6) break;

        const listRoot = findListRoot();
        const scrollAmount = Math.max(400, listRoot.clientHeight - 80);
        listRoot.scrollTop += scrollAmount;
        listRoot.dispatchEvent(new Event("scroll", { bubbles: true }));

        await delay(1500);
      }

      return {
        items: Array.from(collected.values()).slice(0, maxLeads),
        debug: {
          scannedCount: collected.size,
          idlePasses,
          ownerOnlyListNotice,
          othersSummaryText: othersSummaryMatch?.[0] || "",
        },
      };
    },
  });

  if (result?.error) {
    throw new Error(result.error.message ?? JSON.stringify(result.error));
  }
  if (result?.result?.error) {
    throw new Error(result.result.error);
  }
  return result?.result ?? {
    items: [],
    debug: {
      scannedCount: 0,
      idlePasses: 0,
      ownerOnlyListNotice: false,
      othersSummaryText: "",
    },
  };
}

function normalizeCandidate(item) {
  const handle = String(item?.username ?? item?.handle ?? "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
  if (!handle) return null;

  return {
    handle,
    profileUrl: `https://www.instagram.com/${handle}/`,
    displayName: String(item?.name ?? item?.displayName ?? "").replace(/\s+/g, " ").trim(),
  };
}

function warningFromDebug(debug = {}) {
  if (debug.ownerOnlyListNotice) {
    return "Instagram limited this followers list. Only the account owner can see the full followers list for this profile.";
  }
  if (debug.othersSummaryText) {
    return `Instagram limited this followers list. Instagram is showing a preview list (${debug.othersSummaryText}) instead of the full followers list.`;
  }
  return null;
}

export function extractInstagramProfileListNetworkProfiles(sourceType, data) {
  if (sourceType !== "followers" && sourceType !== "following") {
    return new Map();
  }

  const profiles = new Map();
  const normalizeHandle = (value) => String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  const processUser = (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const username = normalizeHandle(node.username);
    if (!username || username.length > 40 || profiles.has(username)) return;

    const bio = String(node.biography || node.bio || "").trim();
    const followerCount = node.follower_count ?? node.edge_followed_by?.count ?? null;
    const postsCount = node.media_count ?? node.edge_owner_to_timeline_media?.count ?? null;

    const externalLinks = [];
    if (node.external_url) externalLinks.push(node.external_url);
    if (Array.isArray(node.bio_links)) {
      node.bio_links.forEach((link) => {
        const url = link?.url || link?.link_url;
        if (url) externalLinks.push(url);
      });
    }

    profiles.set(username, {
      name: String(node.full_name || node.name || "").trim(),
      bio,
      followers_count: followerCount != null ? Number(followerCount) : null,
      posts_count: postsCount != null ? Number(postsCount) : null,
      is_private: typeof node.is_private === "boolean" ? node.is_private : null,
      is_verified: typeof node.is_verified === "boolean" ? node.is_verified : null,
      is_business_account: typeof node.is_business_account === "boolean" ? node.is_business_account : null,
      external_links: [...new Set(externalLinks.filter(Boolean))].join(" | "),
    });
  };

  if (Array.isArray(data?.users)) {
    data.users.forEach(processUser);
  }

  const walkEdges = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 8) return;
    if (Array.isArray(value)) {
      value.forEach((item) => walkEdges(item, depth + 1));
      return;
    }
    if (Array.isArray(value.edges)) {
      value.edges.forEach((edge) => processUser(edge?.node));
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") walkEdges(child, depth + 1);
    }
  };
  walkEdges(data);

  return profiles;
}

async function processNextVisibleFollowerRow(
  executeScript,
  tabId,
  expectedProfileUrl,
  dialogToken,
  processedHandles,
) {
  const [result] = await executeScript({
    target: { tabId },
    args: [expectedProfileUrl, dialogToken, [...processedHandles]],
    func: async (canonicalProfileUrl, boundDialogToken, alreadyProcessed) => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const pathSegments = (value) => String(value || "").split("/").filter(Boolean);
      const reservedProfileRoutes = new Set([
        "about", "accounts", "api", "challenge", "developer", "direct", "emails", "explore",
        "legal", "oauth", "p", "privacy", "reel", "reels", "settings", "stories", "terms", "tv", "web",
      ]);
      const sourceHandleFromCanonicalUrl = (value) => {
        try {
          const parsed = new URL(String(value || ""));
          const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
          const segments = pathSegments(parsed.pathname);
          if (
            parsed.protocol !== "https:" ||
            hostname !== "instagram.com" ||
            segments.length !== 1 ||
            !/^[a-z0-9._]{1,30}$/i.test(segments[0])
          ) return "";
          return segments[0].toLowerCase();
        } catch {
          return "";
        }
      };
      const usernameFromHref = (href) => {
        try {
          const parsed = new URL(String(href || ""), window.location.origin);
          const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
          const segments = pathSegments(parsed.pathname);
          const username = segments[0] || "";
          if (
            parsed.protocol !== "https:" ||
            hostname !== "instagram.com" ||
            segments.length !== 1 ||
            !/^[a-z0-9._]{1,30}$/i.test(username) ||
            reservedProfileRoutes.has(username.toLowerCase())
          ) return "";
          return username.toLowerCase();
        } catch {
          return "";
        }
      };
      const isBoundRoute = (pathname, expectedHandle) => {
        const segments = pathSegments(pathname);
        return (
          segments[0]?.toLowerCase() === expectedHandle &&
          (
            segments.length === 1 ||
            (segments.length === 2 && segments[1].toLowerCase() === "followers") ||
            (segments.length === 3 && segments[1].toLowerCase() === "followers" && segments[2].toLowerCase() === "mutualfirst")
          )
        );
      };
      const controlLabel = (control) => normalize(
        control.textContent || control.getAttribute("aria-label") || control.getAttribute("title") || "",
      ).toLowerCase();
      const isRelationshipLabel = (label) => /^(?:follow|following|follow back|remove|requested|suivre|suivi(?:\(e\))?|suivre aussi|s'abonner|abonn[eé](?:\(e\))?|demandé|demande envoyée|supprimer)$/.test(normalize(label).toLowerCase());
      const isRelationshipControl = (control) => isRelationshipLabel(controlLabel(control));
      const isFollowingControl = (control) => /^(?:following|suivi(?:\(e\))?|abonn[eé](?:\(e\))?)$/.test(controlLabel(control));
      const isFollowRequestControl = (control) => /^(?:requested|demandé|demande envoyée)$/.test(controlLabel(control));
      const isFollowControl = (control) => /^(?:follow|follow back|suivre|suivre aussi|s'abonner)$/.test(controlLabel(control));
      const visibleControls = (row) => Array.from(row.querySelectorAll("button, [role='button']"))
        .filter((control) => isVisible(control) && isRelationshipControl(control));
      const profileUrlFor = (handle) => `https://www.instagram.com/${handle}/`;
      const outcome = (handle, displayName, status, reason) => ({
        handle,
        profileUrl: profileUrlFor(handle),
        displayName,
        status,
        reason,
        at: new Date().toISOString(),
      });
      const findRow = (anchor, handle, dialog) => {
        const isInside = (element, ancestor) => {
          let current = element;
          while (current) {
            if (current === ancestor) return true;
            current = current.parentElement;
          }
          return false;
        };
        let candidate = anchor.parentElement;
        for (let depth = 0; candidate && candidate !== dialog && depth < 8; depth += 1) {
          const handles = new Set(Array.from(candidate.querySelectorAll("a[href]"))
            .filter(isVisible)
            .map((profileAnchor) => usernameFromHref(profileAnchor.getAttribute("href") || profileAnchor.href))
            .filter(Boolean));
          const isSemanticRow = candidate.tagName === "LI" || candidate.tagName === "ARTICLE" || candidate.getAttribute("role") === "listitem";
          const hasSiblingProfile = Array.from(candidate.parentElement?.querySelectorAll?.("a[href]") || [])
            .some((profileAnchor) => {
              const siblingHandle = usernameFromHref(profileAnchor.getAttribute("href") || profileAnchor.href);
              return isVisible(profileAnchor) && siblingHandle && siblingHandle !== handle && !isInside(profileAnchor, candidate);
            });
          const showsHandle = [candidate, ...candidate.querySelectorAll("a, span, div")].some((element) => {
            return normalize(element.textContent).replace(/^@+/, "").toLowerCase() === handle;
          });
          const hasLocalRelationshipControl = visibleControls(candidate).length > 0;
          if (
            handles.size === 1
            && handles.has(handle)
            && showsHandle
            && (hasLocalRelationshipControl || isSemanticRow || hasSiblingProfile)
          ) return candidate;
          candidate = candidate.parentElement;
        }
        return null;
      };
      const displayNameFromRow = (row, handle) => Array.from(row.querySelectorAll("span, div"))
        .map((element) => normalize(element.textContent))
        .find((text) => {
          const value = text.toLowerCase();
          return value && value !== handle && !/^(?:follow|following|follow back|remove|suivre|suivi(?:\(e\))?|suivre aussi|s'abonner|abonn[eé](?:\(e\))?|supprimer)$/.test(value);
        }) || "";
      const handleFromControlRow = (control, dialog) => {
        let candidate = control.parentElement;
        for (let depth = 0; candidate && candidate !== dialog && depth < 8; depth += 1) {
          const controls = visibleControls(candidate);
          if (controls.length === 1 && controls[0] === control) {
            const handle = Array.from(candidate.querySelectorAll("span, div"))
              .filter((element) => !element.querySelector("span, div"))
              .map((element) => normalize(element.textContent).replace(/^@+/, "").toLowerCase())
              .find((value) => (
                /^[a-z0-9._]{1,30}$/i.test(value)
                && !reservedProfileRoutes.has(value)
                && !isRelationshipLabel(value)
              ));
            if (handle) return { handle, row: candidate };
          }
          candidate = candidate.parentElement;
        }
        return null;
      };
      const processRow = async (handle, row) => {
        const displayName = displayNameFromRow(row, handle);
        const controls = visibleControls(row);
        if (controls.length === 0) return outcome(handle, displayName, "failed", "missing-row-control");
        if (controls.length > 1) return outcome(handle, displayName, "failed", "ambiguous-row-control");
        const [control] = controls;
        if (isFollowingControl(control)) return outcome(handle, displayName, "skipped", "already-following");
        if (isFollowRequestControl(control)) return outcome(handle, displayName, "skipped", "already-requested");
        if (!isFollowControl(control)) return outcome(handle, displayName, "failed", "unsupported-row-control");

        control.click();
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const refreshedRow = Array.from(dialog.querySelectorAll("a[href]"))
            .map((anchor) => {
              const currentHandle = usernameFromHref(anchor.getAttribute("href") || anchor.href);
              return currentHandle === handle ? findRow(anchor, handle, dialog) : null;
            })
            .find(Boolean) || row;
          const sameRowControls = visibleControls(refreshedRow);
          if (sameRowControls.length === 1 && isFollowingControl(sameRowControls[0])) {
            return outcome(handle, displayName, "succeeded", null);
          }
          if (sameRowControls.length === 1 && isFollowRequestControl(sameRowControls[0])) {
            return outcome(handle, displayName, "follow_request_sent", null);
          }
          await delay(250);
        }
        return outcome(handle, displayName, "failed", "follow-state-not-confirmed");
      };

      const expectedHandle = sourceHandleFromCanonicalUrl(canonicalProfileUrl);
      if (!expectedHandle || !boundDialogToken) {
        throw new Error("Followers modal binding is missing its canonical source identity.");
      }
      if (!isBoundRoute(window.location.pathname, expectedHandle)) {
        throw new Error("The Followers modal is not on the expected source route.");
      }
      const dialogs = Array.from(document.querySelectorAll("div[role='dialog'], section[role='dialog']"))
        .filter((dialog) => isVisible(dialog) && dialog.getAttribute("data-instagram-followup-dialog") === boundDialogToken);
      if (dialogs.length !== 1) {
        throw new Error(dialogs.length > 1 ? "The bound Followers modal is ambiguous." : "The bound Followers modal is not open.");
      }

      const processed = new Set((Array.isArray(alreadyProcessed) ? alreadyProcessed : []).map((handle) => String(handle).toLowerCase()));
      const [dialog] = dialogs;
      const limitationText = normalize(dialog.innerText || "");
      const debug = {
        ownerOnlyListNotice: (
          /only\s+[^\n]{0,80}\s+can see all followers/i.test(limitationText)
          || /seul(?:\(e\))?\s+[^\n]{0,80}\s+peut voir tous les followers/i.test(limitationText)
        ),
        othersSummaryText: limitationText.match(/\b(?:and|et)\s+([\d.,kmb\s]+)\s+others\b/i)?.[0] || "",
        controlLabels: Array.from(dialog.querySelectorAll("button, [role='button']"))
          .filter(isVisible)
          .map((control) => controlLabel(control))
          .filter(Boolean)
          .slice(0, 30),
        hrefSamples: Array.from(dialog.querySelectorAll("a[href]"))
          .map((anchor) => anchor.getAttribute("href") || anchor.href || "")
          .filter(Boolean)
          .slice(0, 30),
      };
      const scrollableRoots = Array.from(dialog.querySelectorAll("*")).filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        return /(auto|scroll)/i.test(style.overflowY) && element.scrollHeight > element.clientHeight + 50;
      });
      const listRoot = scrollableRoots.reverse().find((element) => element.querySelector("a[href]")) || dialog;

      for (let idlePasses = 0; idlePasses < 6; idlePasses += 1) {
        const anchors = Array.from(dialog.querySelectorAll("a[href]"))
          .filter((anchor) => usernameFromHref(anchor.getAttribute("href") || anchor.href));
        for (const anchor of anchors) {
          const handle = usernameFromHref(anchor.getAttribute("href") || anchor.href);
          if (!handle || processed.has(handle)) continue;
          const row = findRow(anchor, handle, dialog);
          if (!row) continue;
          return { done: false, outcome: await processRow(handle, row), debug };
        }

        const controls = Array.from(dialog.querySelectorAll("button, [role='button']"))
          .filter((control) => isVisible(control) && isRelationshipControl(control));
        for (const control of controls) {
          const candidate = handleFromControlRow(control, dialog);
          if (!candidate || processed.has(candidate.handle)) continue;
          return { done: false, outcome: await processRow(candidate.handle, candidate.row), debug };
        }

        const scrollAmount = Math.max(400, listRoot.clientHeight - 80);
        listRoot.scrollTop += scrollAmount;
        listRoot.dispatchEvent(new Event("scroll", { bubbles: true }));
        await delay(1500);
      }

      return { done: true, debug };
    },
  });

  if (result?.error) throw new Error(result.error.message ?? JSON.stringify(result.error));
  if (result?.result?.error) throw new Error(result.result.error);
  return result?.result ?? { done: true };
}

async function findOwnInstagramProfileUrlFromDom(executeScript, tabId) {
  const [result] = await executeScript({
    target: { tabId },
    args: [],
    func: () => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const profileUrlFromHref = (href) => {
        try {
          const parsed = new URL(String(href || ""), window.location.origin);
          const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
          const segments = parsed.pathname.split("/").filter(Boolean);
          if (
            parsed.protocol !== "https:"
            || hostname !== "instagram.com"
            || segments.length !== 1
            || !/^[a-z0-9._]{1,30}$/i.test(segments[0])
          ) return null;
          return `https://www.instagram.com/${segments[0].toLowerCase()}/`;
        } catch {
          return null;
        }
      };
      const isOwnProfileControl = (anchor) => {
        const label = [
          anchor.getAttribute("aria-label"),
          anchor.getAttribute("title"),
          anchor.textContent,
        ].filter(Boolean).join(" ").toLowerCase().replace(/\s+/g, " ").trim();
        return /(?:^|\s)(?:profile|profil|perfil|profilo)(?:\s|$)/i.test(label);
      };

      const profileUrls = new Set(
        Array.from(document.querySelectorAll("a[href]"))
          .filter((anchor) => isVisible(anchor) && isOwnProfileControl(anchor))
          .map((anchor) => profileUrlFromHref(anchor.getAttribute("href") || anchor.href))
          .filter(Boolean),
      );
      if (profileUrls.size !== 1) {
        return {
          error: profileUrls.size > 1
            ? "The signed-in Instagram profile control is ambiguous."
            : "Could not find the signed-in Instagram profile control.",
        };
      }
      return { profileUrl: Array.from(profileUrls)[0] };
    },
  });

  if (result?.error) throw new Error(result.error.message ?? JSON.stringify(result.error));
  if (result?.result?.error) throw new Error(result.result.error);
  if (!result?.result?.profileUrl) {
    throw new Error("The signed-in Instagram profile script returned no canonical profile URL.");
  }
  return normalizeInstagramProfileTarget(result.result.profileUrl);
}

export function createInstagramFollowers({ openTabAndWait, executeScript, closeTab, log }) {
  if (
    typeof openTabAndWait !== "function" ||
    typeof executeScript !== "function" ||
    typeof closeTab !== "function" ||
    typeof log !== "function"
  ) {
    throw new Error("Instagram follower collection dependencies must be functions.");
  }

  async function collectFollowers({ profileUrl, limit = 200, signal } = {}) {
    const normalizedProfileUrl = normalizeInstagramProfileTarget(profileUrl);
    const normalizedLimit = Math.max(1, Number.parseInt(limit, 10) || 200);
    let tab = null;

    throwIfAborted(signal);
    try {
      tab = await openTabAndWait(normalizedProfileUrl, true);
      if (!tab?.id) throw new Error("Chrome did not return a tab id.");
      throwIfAborted(signal);

      await log("Profile tab opened. Opening followers modal…");
      const opened = await withAbort(
        openProfileListModal(executeScript, tab.id, "followers", normalizedProfileUrl),
        signal,
      );
      throwIfAborted(signal);

      await log("Checking whether Instagram requires expanding the full followers list…");
      const expansion = await withAbort(
        expandFollowersModalIfNeeded(
          executeScript,
          tab.id,
          normalizedProfileUrl,
          opened.dialogToken,
        ),
        signal,
      );
      throwIfAborted(signal);
      if (expansion.expanded) {
        const suffix = expansion.timedOut ? " (timed out while waiting for full refresh)" : "";
        await log(
          `Expanded followers list${suffix}: ` +
          `${expansion.beforeCount ?? 0} -> ${expansion.afterCount ?? 0} visible profile link(s).`,
        );
      } else {
        await log("No extra 'all followers' action detected; scraping the visible followers list directly.");
      }

      const payload = await withAbort(
        collectProfileListFromDom(
          executeScript,
          tab.id,
          "followers",
          normalizedLimit,
          log,
          normalizedProfileUrl,
          opened.dialogToken,
        ),
        signal,
      );
      throwIfAborted(signal);

      const candidatesByHandle = new Map();
      for (const item of payload.items || []) {
        const candidate = normalizeCandidate(item);
        if (candidate && !candidatesByHandle.has(candidate.handle)) {
          candidatesByHandle.set(candidate.handle, candidate);
        }
      }
      const candidates = Array.from(candidatesByHandle.values()).slice(0, normalizedLimit);
      const warning = warningFromDebug(payload.debug);

      await log(
        `DOM collection captured ${candidates.length} visible followers profile(s) ` +
        `(scanned: ${payload.debug?.scannedCount ?? 0}, idle passes: ${payload.debug?.idlePasses ?? 0}).`,
      );
      if (warning) {
        await log(`${warning} Max leads cannot override this UI restriction.`);
      }
      await log(`Collected ${candidates.length} unique followers profile(s).`);

      return { candidates, warning };
    } finally {
      if (tab?.id) {
        await closeTab(tab.id).catch(() => undefined);
      }
    }
  }

  async function collectOwnFollowerHandles({ limit = 200, signal } = {}) {
    const normalizedLimit = Math.max(1, Number.parseInt(limit, 10) || 200);
    let discoveryTab = null;

    throwIfAborted(signal);
    try {
      discoveryTab = await openTabAndWait("https://www.instagram.com/", true);
      if (!discoveryTab?.id) throw new Error("Chrome did not return a tab id.");
      throwIfAborted(signal);

      const profileUrl = await withAbort(
        findOwnInstagramProfileUrlFromDom(executeScript, discoveryTab.id),
        signal,
      );
      throwIfAborted(signal);
      const reviewed = await collectFollowers({ profileUrl, limit: normalizedLimit, signal });
      const handles = Array.from(new Set(
        reviewed.candidates
          .map(({ handle }) => String(handle || "").toLowerCase())
          .filter(Boolean),
      )).slice(0, normalizedLimit);
      const warning = reviewed.warning
        ?? (reviewed.candidates.length >= normalizedLimit
          ? `Instagram follower review reached its ${normalizedLimit}-profile limit. ` +
            "The result may be incomplete; do not treat omitted handles as negative evidence."
          : null);
      return { handles, warning };
    } finally {
      if (discoveryTab?.id) await closeTab(discoveryTab.id).catch(() => undefined);
    }
  }

  async function collectAndFollowFollowers({ profileUrl, limit = 200, onOutcome = async () => {}, signal } = {}) {
    const normalizedProfileUrl = normalizeInstagramProfileTarget(profileUrl);
    const normalizedLimit = Math.max(1, Number.parseInt(limit, 10) || 200);
    if (typeof onOutcome !== "function") throw new Error("Follower outcome callback must be a function.");
    let tab = null;
    const processedHandles = new Set();
    let confirmedFollowCount = 0;
    let warning = null;
    let lastDebug = null;

    throwIfAborted(signal);
    try {
      tab = await openTabAndWait(normalizedProfileUrl, true);
      if (!tab?.id) throw new Error("Chrome did not return a tab id.");
      throwIfAborted(signal);

      await log("Profile tab opened. Opening followers modal for direct follow-up…");
      const opened = await withAbort(
        openProfileListModal(executeScript, tab.id, "followers", normalizedProfileUrl),
        signal,
      );
      throwIfAborted(signal);

      while (confirmedFollowCount < normalizedLimit) {
        const next = await withAbort(
          processNextVisibleFollowerRow(
            executeScript,
            tab.id,
            normalizedProfileUrl,
            opened.dialogToken,
            processedHandles,
          ),
          signal,
        );
        throwIfAborted(signal);
        lastDebug = next.debug || lastDebug;
        warning = warningFromDebug(next.debug) || warning;
        if (next.done || !next.outcome) break;

        processedHandles.add(next.outcome.handle);
        await onOutcome(next.outcome);
        if (["succeeded", "follow_request_sent"].includes(next.outcome.status)) {
          confirmedFollowCount += 1;
        }
        throwIfAborted(signal);
      }

      if (warning) await log(`${warning} Max leads cannot override this UI restriction.`);
      if (processedHandles.size === 0) {
        const diagnostics = {
          controlLabels: Array.isArray(lastDebug?.controlLabels) ? lastDebug.controlLabels : [],
          hrefSamples: Array.isArray(lastDebug?.hrefSamples) ? lastDebug.hrefSamples : [],
        };
        throw new Error(`No eligible visible follower row was found in the bound Followers modal: ${JSON.stringify(diagnostics)}`);
      }
      return { processedCount: confirmedFollowCount, warning };
    } finally {
      if (tab?.id) await closeTab(tab.id).catch(() => undefined);
    }
  }

  return { collectFollowers, collectOwnFollowerHandles, collectAndFollowFollowers };
}
