const LEGACY_SCAN_SELECTORS = "p, li, blockquote, dd, dt, h1, h2, h3, h4";
const TWITTER_SCAN_SELECTORS = 'div[data-testid="tweetText"], article div[lang][dir="auto"]';
const DEFAULT_SCAN_SELECTORS = `${LEGACY_SCAN_SELECTORS}, ${TWITTER_SCAN_SELECTORS}`;
const SETTINGS_SYNC_KEYS = [
  "enabled",
  "autoTranslate",
  "provider",
  "ollamaEndpoint",
  "ollamaModel",
  "azureApiBase",
  "azureModelName",
  "maxConcurrentRequests",
  "requestTimeoutMs",
  "maxCharsPerElement",
  "minWords",
  "scanSelectors",
  "systemPrompt",
  "enabledSites"
];
const SETTINGS_LOCAL_KEYS = ["azureApiKey"];
const TRANSLATION_CACHE_STORAGE_KEY = "translationCache";
const TRANSLATION_CACHE_MAX_ENTRIES = 500;

const DEFAULT_SETTINGS = {
  enabled: true,
  autoTranslate: true,
  provider: "ollama",
  ollamaEndpoint: "http://localhost:11434/api/chat",
  ollamaModel: "gemma4:e4b",
  azureApiBase: "https://<your-resource>.services.ai.azure.com/openai/v1",
  azureApiKey: "",
  azureModelName: "gpt-5-mini",
  maxConcurrentRequests: 2,
  requestTimeoutMs: 45000,
  maxCharsPerElement: 900,
  minWords: 4,
  scanSelectors: DEFAULT_SCAN_SELECTORS,
  systemPrompt: "You are a translation engine. Translate the user's English text into concise, natural Simplified Chinese. Preserve names, code, links, numbers, and formatting intent. Output only the Chinese translation with no explanations.",
  enabledSites: []
};

const translationCache = new Map();
let persistentTranslationCache = null;

function pickSettings(source, keys) {
  return keys.reduce((result, key) => {
    if (key in source) {
      result[key] = source[key];
    }
    return result;
  }, {});
}

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
  const provider = raw.provider === "microsoft-foundry" ? "microsoft-foundry" : DEFAULT_SETTINGS.provider;

  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    provider,
    maxConcurrentRequests: Number(raw.maxConcurrentRequests) > 0 ? Number(raw.maxConcurrentRequests) : DEFAULT_SETTINGS.maxConcurrentRequests,
    requestTimeoutMs: Number(raw.requestTimeoutMs) > 0 ? Number(raw.requestTimeoutMs) : DEFAULT_SETTINGS.requestTimeoutMs,
    maxCharsPerElement: Number(raw.maxCharsPerElement) > 0 ? Number(raw.maxCharsPerElement) : DEFAULT_SETTINGS.maxCharsPerElement,
    minWords: Number(raw.minWords) > 0 ? Number(raw.minWords) : DEFAULT_SETTINGS.minWords,
    ollamaEndpoint: typeof raw.ollamaEndpoint === "string" && raw.ollamaEndpoint.trim() ? raw.ollamaEndpoint.trim() : typeof raw.endpoint === "string" && raw.endpoint.trim() ? raw.endpoint.trim() : DEFAULT_SETTINGS.ollamaEndpoint,
    ollamaModel: typeof raw.ollamaModel === "string" && raw.ollamaModel.trim() ? raw.ollamaModel.trim() : typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : DEFAULT_SETTINGS.ollamaModel,
    azureApiBase: typeof raw.azureApiBase === "string" && raw.azureApiBase.trim() ? raw.azureApiBase.trim() : DEFAULT_SETTINGS.azureApiBase,
    azureApiKey: typeof raw.azureApiKey === "string" ? raw.azureApiKey.trim() : DEFAULT_SETTINGS.azureApiKey,
    azureModelName: typeof raw.azureModelName === "string" && raw.azureModelName.trim() ? raw.azureModelName.trim() : DEFAULT_SETTINGS.azureModelName,
    scanSelectors,
    systemPrompt: typeof raw.systemPrompt === "string" && raw.systemPrompt.trim() ? raw.systemPrompt.trim() : DEFAULT_SETTINGS.systemPrompt,
    enabledSites
  };
}

async function getSettings() {
  const [storedSync, storedLocal] = await Promise.all([
    chrome.storage.sync.get(pickSettings(DEFAULT_SETTINGS, SETTINGS_SYNC_KEYS)),
    chrome.storage.local.get(pickSettings(DEFAULT_SETTINGS, SETTINGS_LOCAL_KEYS))
  ]);
  return normalizeSettings({ ...storedSync, ...storedLocal });
}

async function saveSettings(partialSettings) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...partialSettings });
  await Promise.all([
    chrome.storage.sync.set(pickSettings(next, SETTINGS_SYNC_KEYS)),
    chrome.storage.local.set(pickSettings(next, SETTINGS_LOCAL_KEYS))
  ]);
  return next;
}

function getPublicSettings(settings) {
  return {
    ...settings,
    azureApiKey: ""
  };
}

function getCacheKey(settings, text) {
  const providerModel = settings.provider === "microsoft-foundry"
    ? settings.azureModelName
    : settings.ollamaModel;
  const providerEndpoint = settings.provider === "microsoft-foundry"
    ? settings.azureApiBase
    : settings.ollamaEndpoint;
  return `${settings.provider}::${providerEndpoint}::${providerModel}::${settings.systemPrompt}::${text}`;
}

async function getPersistentTranslationCache() {
  if (persistentTranslationCache) {
    return persistentTranslationCache;
  }

  try {
    const stored = await chrome.storage.local.get({ [TRANSLATION_CACHE_STORAGE_KEY]: {} });
    const cache = stored[TRANSLATION_CACHE_STORAGE_KEY];
    persistentTranslationCache = cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
  } catch (error) {
    console.warn("[TEP] failed to load persistent translation cache", error);
    persistentTranslationCache = {};
  }

  return persistentTranslationCache;
}

async function getCachedTranslation(cacheKey) {
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  const cache = await getPersistentTranslationCache();
  const entry = cache[cacheKey];
  if (!entry || typeof entry.translation !== "string") {
    return null;
  }

  translationCache.set(cacheKey, entry.translation);
  return entry.translation;
}

function prunePersistentTranslationCache(cache) {
  const entries = Object.entries(cache);
  if (entries.length <= TRANSLATION_CACHE_MAX_ENTRIES) {
    return;
  }

  entries
    .sort(([, left], [, right]) => (Number(left?.updatedAt) || 0) - (Number(right?.updatedAt) || 0))
    .slice(0, entries.length - TRANSLATION_CACHE_MAX_ENTRIES)
    .forEach(([cacheKey]) => {
      delete cache[cacheKey];
    });
}

async function setCachedTranslation(cacheKey, translation) {
  translationCache.set(cacheKey, translation);

  try {
    const cache = await getPersistentTranslationCache();
    cache[cacheKey] = {
      translation,
      updatedAt: Date.now()
    };
    prunePersistentTranslationCache(cache);
    await chrome.storage.local.set({ [TRANSLATION_CACHE_STORAGE_KEY]: cache });
  } catch (error) {
    console.warn("[TEP] failed to save persistent translation cache", error);
  }
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

async function requestOllamaTranslation(text, settings, signal) {
  const response = await fetch(settings.ollamaEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.ollamaModel,
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

async function requestMicrosoftFoundryTranslation(text, settings, signal) {
  const response = await fetch(`${settings.azureApiBase.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": settings.azureApiKey
    },
    body: JSON.stringify({
      model: settings.azureModelName,
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
    if (response.status === 401 || response.status === 403) {
      throw new Error("Microsoft Foundry rejected the API key or request permissions.");
    }

    if (response.status === 404) {
      throw new Error("Microsoft Foundry endpoint or model name was not found. Check AZURE_API_BASE and MODEL_NAME.");
    }

    if (response.status === 429) {
      throw new Error("Microsoft Foundry rate limited the request with HTTP 429.");
    }

    throw new Error(`Microsoft Foundry request failed with status ${response.status}`);
  }

  const data = await response.json();
  const translated = data?.choices?.[0]?.message?.content?.trim();

  if (!translated) {
    throw new Error("Microsoft Foundry returned an empty translation");
  }

  return translated;
}

async function requestTranslation(text, settings, signal) {
  if (settings.provider === "microsoft-foundry") {
    if (!settings.azureApiBase) {
      throw new Error("Missing AZURE_API_BASE for Microsoft Foundry");
    }

    if (!settings.azureApiKey) {
      throw new Error("Missing AZURE_API_KEY for Microsoft Foundry");
    }

    if (!settings.azureModelName) {
      throw new Error("Missing MODEL_NAME for Microsoft Foundry");
    }

    return requestMicrosoftFoundryTranslation(text, settings, signal);
  }

  return requestOllamaTranslation(text, settings, signal);
}

async function testConnection(partialSettings) {
  const current = await getSettings();
  const settings = normalizeSettings({ ...current, ...partialSettings });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.min(settings.requestTimeoutMs, 15000));

  try {
    const translation = await requestTranslation("Hello world", settings, controller.signal);
    return {
      provider: settings.provider,
      translation
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function translateText(text, settings) {
  const cleanedText = typeof text === "string" ? text.trim() : "";
  if (!cleanedText) {
    return "";
  }

  const cacheKey = getCacheKey(settings, cleanedText);
  const cachedTranslation = await getCachedTranslation(cacheKey);
  if (cachedTranslation) {
    return cachedTranslation;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), settings.requestTimeoutMs);

  try {
    const chunks = splitTextIntoChunks(cleanedText, settings.maxCharsPerElement);
    const translatedChunks = [];

    for (const chunk of chunks) {
      const chunkCacheKey = getCacheKey(settings, chunk);
      const cachedChunkTranslation = await getCachedTranslation(chunkCacheKey);
      if (cachedChunkTranslation) {
        translatedChunks.push(cachedChunkTranslation);
        continue;
      }

      const translatedChunk = await requestTranslation(chunk, settings, controller.signal);
      await setCachedTranslation(chunkCacheKey, translatedChunk);
      translatedChunks.push(translatedChunk);
    }

    const translated = translatedChunks.join("");

    await setCachedTranslation(cacheKey, translated);
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
  const local = await chrome.storage.local.get(null);
  const next = normalizeSettings({ ...current, ...local });
  await Promise.all([
    chrome.storage.sync.set(pickSettings(next, SETTINGS_SYNC_KEYS)),
    chrome.storage.local.set(pickSettings(next, SETTINGS_LOCAL_KEYS))
  ]);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_SETTINGS": {
        sendResponse({ ok: true, settings: getPublicSettings(await getSettings()) });
        return;
      }
      case "GET_OPTIONS_SETTINGS": {
        sendResponse({ ok: true, settings: await getSettings() });
        return;
      }
      case "SAVE_SETTINGS": {
        sendResponse({ ok: true, settings: await saveSettings(message.settings || {}) });
        return;
      }
      case "TEST_CONNECTION": {
        sendResponse({ ok: true, result: await testConnection(message.settings || {}) });
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
