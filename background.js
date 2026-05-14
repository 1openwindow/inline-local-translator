const LEGACY_SCAN_SELECTORS = "p, li, blockquote, dd, dt, h1, h2, h3, h4";
const TWITTER_SCAN_SELECTORS = 'div[data-testid="tweetText"], article div[lang][dir="auto"]';
const DEFAULT_SCAN_SELECTORS = `${LEGACY_SCAN_SELECTORS}, ${TWITTER_SCAN_SELECTORS}`;

const DEFAULT_SETTINGS = {
  enabled: true,
  autoTranslate: true,
  endpoint: "http://localhost:11434/api/chat",
  model: "gemma4:e4b",
  requestTimeoutMs: 45000,
  maxCharsPerElement: 900,
  minWords: 4,
  scanSelectors: DEFAULT_SCAN_SELECTORS,
  systemPrompt: "You are a translation engine. Translate the user's English text into concise, natural Simplified Chinese. Preserve names, code, links, numbers, and formatting intent. Output only the Chinese translation with no explanations.",
  enabledSites: []
};

const translationCache = new Map();

function normalizeSettings(raw = {}) {
  const enabledSites = Array.isArray(raw.enabledSites)
    ? Array.from(new Set(raw.enabledSites
      .filter((item) => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)))
    : DEFAULT_SETTINGS.enabledSites;
  const rawScanSelectors = typeof raw.scanSelectors === "string" ? raw.scanSelectors.trim() : "";
  const scanSelectors = !rawScanSelectors || rawScanSelectors === LEGACY_SCAN_SELECTORS
    ? DEFAULT_SCAN_SELECTORS
    : rawScanSelectors.includes('div[data-testid="tweetText"]') || rawScanSelectors.includes('article div[lang][dir="auto"]')
      ? rawScanSelectors
      : `${rawScanSelectors}, ${TWITTER_SCAN_SELECTORS}`;

  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    requestTimeoutMs: Number(raw.requestTimeoutMs) > 0 ? Number(raw.requestTimeoutMs) : DEFAULT_SETTINGS.requestTimeoutMs,
    maxCharsPerElement: Number(raw.maxCharsPerElement) > 0 ? Number(raw.maxCharsPerElement) : DEFAULT_SETTINGS.maxCharsPerElement,
    minWords: Number(raw.minWords) > 0 ? Number(raw.minWords) : DEFAULT_SETTINGS.minWords,
    endpoint: typeof raw.endpoint === "string" && raw.endpoint.trim() ? raw.endpoint.trim() : DEFAULT_SETTINGS.endpoint,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : DEFAULT_SETTINGS.model,
    scanSelectors,
    systemPrompt: typeof raw.systemPrompt === "string" && raw.systemPrompt.trim() ? raw.systemPrompt.trim() : DEFAULT_SETTINGS.systemPrompt,
    enabledSites
  };
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return normalizeSettings(stored);
}

async function saveSettings(partialSettings) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...partialSettings });
  await chrome.storage.sync.set(next);
  return next;
}

function getCacheKey(settings, text) {
  return `${settings.model}::${text}`;
}

function splitOversizeSegment(segment, maxChars) {
  if (segment.length <= maxChars) {
    return [segment];
  }

  const words = segment.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    const chunks = [];
    for (let index = 0; index < segment.length; index += maxChars) {
      chunks.push(segment.slice(index, index + maxChars));
    }
    return chunks;
  }

  const chunks = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (word.length <= maxChars) {
      current = word;
      continue;
    }

    chunks.push(...splitOversizeSegment(word, maxChars));
    current = "";
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitTextIntoChunks(text, maxChars) {
  if (text.length <= maxChars) {
    return [text];
  }

  const sentenceParts = text
    .split(/(?<=[.!?。！？])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const segments = sentenceParts.length > 1
    ? sentenceParts
    : text
      .split(/(?<=[,;:])\s+/)
      .map((part) => part.trim())
      .filter(Boolean);

  const chunks = [];
  let current = "";

  for (const segment of segments) {
    if (segment.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }

      chunks.push(...splitOversizeSegment(segment, maxChars));
      continue;
    }

    const next = current ? `${current} ${segment}` : segment;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
    }
    current = segment;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : splitOversizeSegment(text, maxChars);
}

async function requestTranslation(text, settings, signal) {
  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      messages: [
        {
          role: "system",
          content: settings.systemPrompt
        },
        {
          role: "user",
          content: text
        }
      ]
    }),
    signal
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        "Ollama rejected the browser extension origin with HTTP 403. Configure OLLAMA_ORIGINS to allow this extension, for example: OLLAMA_ORIGINS=chrome-extension://*,extension://*"
      );
    }

    throw new Error(`Ollama request failed with status ${response.status}`);
  }

  const data = await response.json();
  const translated = data?.message?.content?.trim();

  if (!translated) {
    throw new Error("Ollama returned an empty translation");
  }

  return translated;
}

async function translateText(text, settings) {
  const cleanedText = typeof text === "string" ? text.trim() : "";
  if (!cleanedText) {
    return "";
  }

  const cacheKey = getCacheKey(settings, cleanedText);
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), settings.requestTimeoutMs);

  try {
    const chunks = splitTextIntoChunks(cleanedText, settings.maxCharsPerElement);
    const translatedChunks = [];

    for (const chunk of chunks) {
      const chunkCacheKey = getCacheKey(settings, chunk);
      if (translationCache.has(chunkCacheKey)) {
        translatedChunks.push(translationCache.get(chunkCacheKey));
        continue;
      }

      const translatedChunk = await requestTranslation(chunk, settings, controller.signal);
      translationCache.set(chunkCacheKey, translatedChunk);
      translatedChunks.push(translatedChunk);
    }

    const translated = translatedChunks.join("");

    translationCache.set(cacheKey, translated);
    return translated;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function setSiteEnabled(hostname, enabled) {
  const settings = await getSettings();
  const normalizedHostname = hostname.toLowerCase();
  const nextEnabledSites = new Set(settings.enabledSites);

  if (enabled) {
    nextEnabledSites.add(normalizedHostname);
  } else {
    nextEnabledSites.delete(normalizedHostname);
  }

  return saveSettings({ enabledSites: Array.from(nextEnabledSites).sort() });
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set(normalizeSettings(current));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_SETTINGS": {
        sendResponse({ ok: true, settings: await getSettings() });
        return;
      }
      case "SAVE_SETTINGS": {
        sendResponse({ ok: true, settings: await saveSettings(message.settings || {}) });
        return;
      }
      case "TRANSLATE_TEXT": {
        const settings = await getSettings();
        const translation = await translateText(message.text, settings);
        sendResponse({ ok: true, translation, settings });
        return;
      }
      case "SET_SITE_ENABLED": {
        const hostname = typeof message.hostname === "string" ? message.hostname.trim() : "";
        if (!hostname) {
          throw new Error("Missing hostname");
        }

        sendResponse({ ok: true, settings: await setSiteEnabled(hostname, Boolean(message.enabled)) });
        return;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });

  return true;
});
