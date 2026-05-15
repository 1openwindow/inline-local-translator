function normalizeRuntimeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Unknown message type")) {
    return "扩展后台还是旧版本，请到 edge://extensions 重新加载这个扩展后再试。";
  }
  return message;
}

async function sendRuntimeMessage(message, fallbackType) {
  const response = await chrome.runtime.sendMessage(message);

  if (response?.ok) {
    return response;
  }

  if (response?.error === "Unknown message type" && fallbackType) {
    const fallbackResponse = await chrome.runtime.sendMessage({ ...message, type: fallbackType });
    if (fallbackResponse?.ok) {
      return fallbackResponse;
    }
    throw new Error(fallbackResponse?.error || response.error);
  }

  throw new Error(response?.error || "Failed to send message");
}

async function getSettings() {
  const response = await sendRuntimeMessage({ type: "GET_OPTIONS_SETTINGS" }, "GET_SETTINGS");
  return response.settings;
}

function setStatus(text, isError = false) {
  const status = document.querySelector("#status");
  status.textContent = text;
  status.style.color = isError ? "#b42318" : "#4d647a";
}

function collectFormSettings(fields) {
  return {
    autoTranslate: fields.autoTranslate.checked,
    provider: fields.provider.value,
    enabledSites: fields.enabledSites.value
      .split(/\n+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
    ollamaEndpoint: fields.ollamaEndpoint.value.trim(),
    ollamaModel: fields.ollamaModel.value.trim(),
    azureApiBase: fields.azureApiBase.value.trim(),
    azureApiKey: fields.azureApiKey.value.trim(),
    azureModelName: fields.azureModelName.value.trim(),
    maxConcurrentRequests: Number(fields.maxConcurrentRequests.value),
    requestTimeoutMs: Number(fields.requestTimeoutMs.value),
    maxCharsPerElement: Number(fields.maxCharsPerElement.value),
    minWords: Number(fields.minWords.value),
    scanSelectors: fields.scanSelectors.value.trim(),
    systemPrompt: fields.systemPrompt.value.trim()
  };
}

function updateProviderSections(provider) {
  const sections = document.querySelectorAll(".provider-section");
  sections.forEach((section) => {
    section.hidden = section.dataset.provider !== provider;
  });
}

async function initialize() {
  const form = document.querySelector("#settings-form");
  const testConnectionButton = document.querySelector("#testConnection");
  const fields = {
    autoTranslate: document.querySelector("#autoTranslate"),
    enabledSites: document.querySelector("#enabledSites"),
    provider: document.querySelector("#provider"),
    ollamaEndpoint: document.querySelector("#ollamaEndpoint"),
    ollamaModel: document.querySelector("#ollamaModel"),
    azureApiBase: document.querySelector("#azureApiBase"),
    azureApiKey: document.querySelector("#azureApiKey"),
    azureModelName: document.querySelector("#azureModelName"),
    maxConcurrentRequests: document.querySelector("#maxConcurrentRequests"),
    requestTimeoutMs: document.querySelector("#requestTimeoutMs"),
    maxCharsPerElement: document.querySelector("#maxCharsPerElement"),
    minWords: document.querySelector("#minWords"),
    scanSelectors: document.querySelector("#scanSelectors"),
    systemPrompt: document.querySelector("#systemPrompt")
  };

  const settings = await getSettings();
  fields.autoTranslate.checked = Boolean(settings.autoTranslate);
  fields.enabledSites.value = settings.enabledSites.join("\n");
  fields.provider.value = settings.provider;
  fields.ollamaEndpoint.value = settings.ollamaEndpoint;
  fields.ollamaModel.value = settings.ollamaModel;
  fields.azureApiBase.value = settings.azureApiBase;
  fields.azureApiKey.value = settings.azureApiKey;
  fields.azureModelName.value = settings.azureModelName;
  fields.maxConcurrentRequests.value = String(settings.maxConcurrentRequests);
  fields.requestTimeoutMs.value = String(settings.requestTimeoutMs);
  fields.maxCharsPerElement.value = String(settings.maxCharsPerElement);
  fields.minWords.value = String(settings.minWords);
  fields.scanSelectors.value = settings.scanSelectors;
  fields.systemPrompt.value = settings.systemPrompt;
  updateProviderSections(settings.provider);

  fields.provider.addEventListener("change", () => {
    updateProviderSections(fields.provider.value);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await sendRuntimeMessage({
        type: "SAVE_SETTINGS",
        settings: collectFormSettings(fields)
      });

      setStatus("设置已保存，页面会在下次扫描时使用新配置。");
    } catch (error) {
      setStatus(normalizeRuntimeError(error), true);
    }
  });

  testConnectionButton.addEventListener("click", async () => {
    testConnectionButton.disabled = true;
    setStatus("正在测试连接...");

    try {
      const response = await sendRuntimeMessage({
        type: "TEST_CONNECTION",
        settings: collectFormSettings(fields)
      });

      const result = response.result;
      setStatus(`连接成功：${result.provider} 返回“${result.translation}”`);
    } catch (error) {
      setStatus(normalizeRuntimeError(error), true);
    } finally {
      testConnectionButton.disabled = false;
    }
  });
}

void initialize().catch((error) => {
  setStatus(normalizeRuntimeError(error), true);
});
