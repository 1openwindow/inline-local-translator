async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getSettings() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  if (!response?.ok) {
    throw new Error(response?.error || "Failed to load settings");
  }
  return response.settings;
}

async function sendToTab(tabId, message) {
  if (!tabId) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Ignore pages where the content script is unavailable.
  }
}

function setStatus(text, isError = false) {
  const status = document.querySelector("#status");
  status.textContent = text;
  status.style.color = isError ? "#b42318" : "#4d647a";
}

function isSiteEnabled(settings, hostname) {
  return Boolean(settings.enabled) && settings.enabledSites.includes(hostname);
}

async function initialize() {
  const enabledInput = document.querySelector("#enabled");
  const siteEnabledInput = document.querySelector("#site-enabled");
  const hostnameNode = document.querySelector("#hostname");
  const translateButton = document.querySelector("#translate-page");
  const clearButton = document.querySelector("#clear-page");
  const openOptionsButton = document.querySelector("#open-options");

  const [tab, settings] = await Promise.all([getActiveTab(), getSettings()]);
  const url = tab?.url ? new URL(tab.url) : null;
  const supportedPage = Boolean(url && /^https?:$/.test(url.protocol));
  const hostname = supportedPage ? url.hostname : "当前页面不支持";

  hostnameNode.textContent = `站点: ${hostname}`;
  enabledInput.checked = Boolean(settings.enabled);
  siteEnabledInput.checked = supportedPage ? isSiteEnabled(settings, hostname) : false;
  siteEnabledInput.disabled = !supportedPage;
  translateButton.disabled = !supportedPage;
  clearButton.disabled = !supportedPage;

  enabledInput.addEventListener("change", async () => {
    try {
      await chrome.runtime.sendMessage({
        type: "SAVE_SETTINGS",
        settings: { enabled: enabledInput.checked }
      });
      await sendToTab(tab?.id, { type: "REFRESH_SETTINGS" });
      setStatus(enabledInput.checked ? "已启用自动翻译" : "已关闭自动翻译");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });

  siteEnabledInput.addEventListener("change", async () => {
    try {
      await chrome.runtime.sendMessage({
        type: "SET_SITE_ENABLED",
        hostname,
        enabled: siteEnabledInput.checked
      });
      await sendToTab(tab?.id, { type: "REFRESH_SETTINGS" });
      setStatus(siteEnabledInput.checked ? "当前网站已加入启用列表" : "当前网站已移出启用列表");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });

  translateButton.addEventListener("click", async () => {
    await sendToTab(tab?.id, { type: "TRANSLATE_PAGE" });
    setStatus("已触发当前页面翻译");
  });

  clearButton.addEventListener("click", async () => {
    await sendToTab(tab?.id, { type: "CLEAR_TRANSLATIONS" });
    setStatus("已清除当前页面翻译");
  });

  openOptionsButton.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

void initialize().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), true);
});
