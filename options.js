async function getSettings() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  if (!response?.ok) {
    throw new Error(response?.error || "Failed to load settings");
  }
  return response.settings;
}

function setStatus(text, isError = false) {
  const status = document.querySelector("#status");
  status.textContent = text;
  status.style.color = isError ? "#b42318" : "#4d647a";
}

async function initialize() {
  const form = document.querySelector("#settings-form");
  const fields = {
    autoTranslate: document.querySelector("#autoTranslate"),
    enabledSites: document.querySelector("#enabledSites"),
    endpoint: document.querySelector("#endpoint"),
    model: document.querySelector("#model"),
    requestTimeoutMs: document.querySelector("#requestTimeoutMs"),
    maxCharsPerElement: document.querySelector("#maxCharsPerElement"),
    minWords: document.querySelector("#minWords"),
    scanSelectors: document.querySelector("#scanSelectors"),
    systemPrompt: document.querySelector("#systemPrompt")
  };

  const settings = await getSettings();
  fields.autoTranslate.checked = Boolean(settings.autoTranslate);
  fields.enabledSites.value = settings.enabledSites.join("\n");
  fields.endpoint.value = settings.endpoint;
  fields.model.value = settings.model;
  fields.requestTimeoutMs.value = String(settings.requestTimeoutMs);
  fields.maxCharsPerElement.value = String(settings.maxCharsPerElement);
  fields.minWords.value = String(settings.minWords);
  fields.scanSelectors.value = settings.scanSelectors;
  fields.systemPrompt.value = settings.systemPrompt;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await chrome.runtime.sendMessage({
        type: "SAVE_SETTINGS",
        settings: {
          autoTranslate: fields.autoTranslate.checked,
          enabledSites: fields.enabledSites.value
            .split(/\n+/)
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean),
          endpoint: fields.endpoint.value.trim(),
          model: fields.model.value.trim(),
          requestTimeoutMs: Number(fields.requestTimeoutMs.value),
          maxCharsPerElement: Number(fields.maxCharsPerElement.value),
          minWords: Number(fields.minWords.value),
          scanSelectors: fields.scanSelectors.value.trim(),
          systemPrompt: fields.systemPrompt.value.trim()
        }
      });

      setStatus("设置已保存，页面会在下次扫描时使用新配置。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
}

void initialize().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), true);
});
