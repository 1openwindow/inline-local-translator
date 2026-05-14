const TRANSLATION_CLASS = "tep-translation";
const TRANSLATION_LABEL = "中文";
const INDICATOR_CLASS = "tep-indicator";
const TWITTER_TEXT_SELECTORS = 'div[data-testid="tweetText"], article div[lang][dir="auto"]';
let elementState = new WeakMap();
let translationNodes = new WeakMap();
const pageCache = new Map();

let settings = null;
let observer = null;
let scanTimer = null;
let pendingScanRoots = new Set();
let activeJobs = 0;
let translationRunId = 0;
let indicatorNode = null;
let hideIndicatorTimer = null;
let hadVisibleWork = false;
let failedJobs = 0;
const jobQueue = [];

function getHostname() {
  return window.location.hostname.toLowerCase();
}

function isTwitterHost() {
  const hostname = getHostname();
  return hostname === "x.com" || hostname.endsWith(".x.com") || hostname === "twitter.com" || hostname.endsWith(".twitter.com");
}

function isCurrentSiteEnabled() {
  return Boolean(settings?.enabled) && settings.enabledSites.includes(getHostname());
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function isVisible(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function shouldSkipElement(element) {
  if (!(element instanceof HTMLElement)) {
    return true;
  }

  if (element.closest(`.${TRANSLATION_CLASS}`)) {
    return true;
  }

  if (element.closest("script, style, noscript, code, pre, textarea, input, select, button, svg, canvas, header, footer, nav, aside, form")) {
    return true;
  }

  if (element.isContentEditable) {
    return true;
  }

  return !isVisible(element);
}

function isTweetText(element) {
  return element instanceof HTMLElement && (
    element.matches('div[data-testid="tweetText"]') ||
    (isTwitterHost() && element.matches('article div[lang][dir="auto"]'))
  );
}

function looksEnglish(text, element) {
  const asciiLetters = (text.match(/[A-Za-z]/g) || []).length;
  const chineseChars = (text.match(/[\u3400-\u9FFF]/g) || []).length;
  const words = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const minWords = isTweetText(element) ? Math.min(settings.minWords, 2) : settings.minWords;
  const minLetters = isTweetText(element) ? 8 : 18;

  if (words.length < minWords) {
    return false;
  }

  if (asciiLetters < minLetters) {
    return false;
  }

  if (chineseChars > asciiLetters / 2) {
    return false;
  }

  return true;
}

function getElementText(element) {
  return normalizeText(element.innerText || element.textContent || "");
}

function hasNestedCandidate(element) {
  if (isTweetText(element)) {
    return false;
  }

  try {
    return Boolean(element.querySelector(settings.scanSelectors));
  } catch {
    return false;
  }
}

function isCandidate(element) {
  if (shouldSkipElement(element)) {
    return false;
  }

  if (element.children.length > 0 && hasNestedCandidate(element)) {
    return false;
  }

  const text = getElementText(element);
  if (!text) {
    return false;
  }

  return looksEnglish(text, element);
}

function findCandidateContainer(node) {
  if (!(node instanceof Element)) {
    return null;
  }

  if (node.matches(TWITTER_TEXT_SELECTORS)) {
    return node;
  }

  try {
    return node.closest(TWITTER_TEXT_SELECTORS) || node.closest(settings?.scanSelectors || "") || null;
  } catch {
    return node.closest(TWITTER_TEXT_SELECTORS) || null;
  }
}

function ensureIndicatorNode() {
  if (indicatorNode?.isConnected) {
    return indicatorNode;
  }

  indicatorNode = document.createElement("div");
  indicatorNode.className = INDICATOR_CLASS;
  indicatorNode.hidden = true;
  indicatorNode.innerHTML = [
    '<span class="tep-indicator-spinner" aria-hidden="true"></span>',
    '<span class="tep-indicator-text"></span>'
  ].join("");

  document.body.appendChild(indicatorNode);
  return indicatorNode;
}

function updateIndicator() {
  if (!document.body) {
    return;
  }

  const node = ensureIndicatorNode();
  const textNode = node.querySelector(".tep-indicator-text");
  const running = activeJobs;
  const queued = jobQueue.length;

  window.clearTimeout(hideIndicatorTimer);

  if (running > 0 || queued > 0) {
    hadVisibleWork = true;
    node.hidden = false;
    node.dataset.tepState = "active";
    textNode.textContent = running > 0
      ? `翻译中 ${running} 段，排队 ${queued} 段`
      : `准备翻译 ${queued} 段`;
    return;
  }

  if (!hadVisibleWork) {
    node.hidden = true;
    return;
  }

  node.hidden = false;
  node.dataset.tepState = failedJobs > 0 ? "warning" : "done";
  textNode.textContent = failedJobs > 0 ? `翻译完成，${failedJobs} 段失败` : "翻译完成";
  hadVisibleWork = false;
  failedJobs = 0;
  hideIndicatorTimer = window.setTimeout(() => {
    node.hidden = true;
  }, 1600);
}

function ensureTranslationNode(element) {
  const existing = translationNodes.get(element);
  if (existing?.isConnected) {
    return existing;
  }

  const node = document.createElement("div");
  node.className = TRANSLATION_CLASS;
  node.dataset.tepState = "loading";
  element.insertAdjacentElement("afterend", node);
  translationNodes.set(element, node);
  return node;
}

function renderTranslation(element, content, state) {
  const node = ensureTranslationNode(element);
  node.dataset.tepState = state;
  node.innerHTML = "";

  const label = document.createElement("strong");
  label.textContent = `${TRANSLATION_LABEL}:`;
  node.appendChild(label);
  node.appendChild(document.createTextNode(content));
}

function clearTranslation(element) {
  const node = translationNodes.get(element);
  if (node?.isConnected) {
    node.remove();
  }
  translationNodes.delete(element);
  elementState.delete(element);
}

function clearAllTranslations() {
  document.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((node) => node.remove());
  pageCache.clear();
  jobQueue.length = 0;
  pendingScanRoots.clear();
  translationRunId += 1;
  activeJobs = 0;
  failedJobs = 0;
  hadVisibleWork = false;
  elementState = new WeakMap();
  translationNodes = new WeakMap();

  if (indicatorNode?.isConnected) {
    indicatorNode.hidden = true;
  }
}

function enqueue(element) {
  if (elementState.get(element) === "queued" || elementState.get(element) === "done" || elementState.get(element) === "running") {
    return;
  }

  elementState.set(element, "queued");
  jobQueue.push({ element, runId: translationRunId });
  updateIndicator();
  void drainQueue();
}

async function translateElement(element, runId) {
  const text = getElementText(element);
  if (!text) {
    elementState.delete(element);
    return;
  }

  const cached = pageCache.get(text);
  if (cached) {
    renderTranslation(element, cached, "done");
    elementState.set(element, "done");
    return;
  }

  renderTranslation(element, "翻译中...", "loading");

  const response = await chrome.runtime.sendMessage({
    type: "TRANSLATE_TEXT",
    text
  });

  if (runId !== translationRunId || !element.isConnected) {
    return;
  }

  if (!response?.ok) {
    throw new Error(response?.error || "Translation failed");
  }

  pageCache.set(text, response.translation);
  renderTranslation(element, response.translation, "done");
  elementState.set(element, "done");
}

async function drainQueue() {
  while (activeJobs < 2 && jobQueue.length > 0) {
    const job = jobQueue.shift();
    const element = job?.element;
    const runId = job?.runId;
    if (runId !== translationRunId) {
      continue;
    }

    if (!element?.isConnected || !isCandidate(element)) {
      elementState.delete(element);
      updateIndicator();
      continue;
    }

    activeJobs += 1;
    elementState.set(element, "running");
    updateIndicator();

    void translateElement(element, runId)
      .catch((error) => {
        if (runId !== translationRunId || !element.isConnected) {
          return;
        }

        renderTranslation(element, error instanceof Error ? error.message : String(error), "error");
        elementState.set(element, "error");
        failedJobs += 1;
      })
      .finally(() => {
        activeJobs = Math.max(0, activeJobs - 1);
        updateIndicator();
        void drainQueue();
      });
  }
}

function collectCandidates(root = document) {
  if (!isCurrentSiteEnabled()) {
    return [];
  }

  const scope = root instanceof Element || root instanceof Document ? root : document;

  try {
    const candidates = new Set();

    if (scope instanceof Element && scope.matches(settings.scanSelectors) && isCandidate(scope)) {
      candidates.add(scope);
    }

    for (const element of scope.querySelectorAll(settings.scanSelectors)) {
      if (isCandidate(element)) {
        candidates.add(element);
      }
    }

    if (isTwitterHost()) {
      if (scope instanceof Element && scope.matches(TWITTER_TEXT_SELECTORS) && isCandidate(scope)) {
        candidates.add(scope);
      }

      for (const element of scope.querySelectorAll(TWITTER_TEXT_SELECTORS)) {
        if (isCandidate(element)) {
          candidates.add(element);
        }
      }
    }

    return Array.from(candidates);
  } catch {
    return [];
  }
}

function scheduleScan(root = document, force = false) {
  if (!isCurrentSiteEnabled()) {
    return;
  }

  if (!force && !settings.autoTranslate) {
    return;
  }

  pendingScanRoots.add(root instanceof Element || root instanceof Document ? root : document);
  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => {
    const roots = Array.from(pendingScanRoots);
    pendingScanRoots.clear();

    for (const pendingRoot of roots) {
      collectCandidates(pendingRoot).forEach(enqueue);
    }
  }, 300);
}

function startObserver() {
  if (observer) {
    observer.disconnect();
  }

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) {
            scheduleScan(node);
          }
        });
      }

      if (mutation.type === "characterData" && mutation.target.parentElement) {
        const candidateContainer = findCandidateContainer(mutation.target.parentElement);
        if (!candidateContainer) {
          continue;
        }

        clearTranslation(candidateContainer);
        scheduleScan(candidateContainer);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

async function refreshSettings() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  if (!response?.ok) {
    throw new Error(response?.error || "Failed to load settings");
  }

  settings = response.settings;
}

async function initialize() {
  console.log("[TEP] content script loaded", window.location.href);
  await refreshSettings();
  console.log("[TEP] settings loaded", {
    enabled: settings.enabled,
    autoTranslate: settings.autoTranslate,
    scanSelectors: settings.scanSelectors,
    enabledSites: settings.enabledSites
  });

  if (!document.body) {
    console.warn("[TEP] initialize aborted: document.body is unavailable", window.location.href);
    return;
  }

  startObserver();
  scheduleScan(document);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "TRANSLATE_PAGE") {
      await refreshSettings();
      scheduleScan(document, true);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "CLEAR_TRANSLATIONS") {
      clearAllTranslations();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "REFRESH_SETTINGS") {
      await refreshSettings();
      clearAllTranslations();
      scheduleScan(document);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type" });
  })().catch((error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });

  return true;
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "sync" || !changes) {
    return;
  }

  await refreshSettings();
  clearAllTranslations();
  scheduleScan(document);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void initialize();
  }, { once: true });
} else {
  void initialize();
}

window.addEventListener("error", (event) => {
  console.error("[TEP] uncaught error", event.error || event.message || event);
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("[TEP] unhandled rejection", event.reason || event);
});
