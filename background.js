// Content scripts only load into pages opened AFTER the extension is installed or updated.
// This injects Marker into tabs that were already open so it works without a manual refresh.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install" && details.reason !== "update") return;

  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*", "file:///*"] });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
    } catch (e) {
      // Protected, discarded or not-yet-allowed tabs (e.g. file:// without the toggle) are skipped.
    }
  }
});
