(function () {
  "use strict";

  const qs = (id) => document.getElementById(id);
  const els = {
    shortcutSave: qs("shortcutSave"),
    shortcutOpen: qs("shortcutOpen"),
    openShortcutsPage: qs("openShortcutsPage"),
    shortcutsFallback: qs("shortcutsFallback"),
    exportBtn: qs("exportBtn"),
    importBtn: qs("importBtn"),
    importFile: qs("importFile"),
    backupStatus: qs("backupStatus"),
    stats: qs("stats"),
  };

  function sendMessage(type, payload) {
    return browser.runtime.sendMessage({ type, ...payload });
  }

  function isFirefox() {
    return navigator.userAgent.includes("Firefox");
  }

  async function loadShortcuts() {
    if (!browser.commands || !browser.commands.getAll) {
      els.shortcutSave.textContent = "Unavailable";
      els.shortcutOpen.textContent = "Unavailable";
      return;
    }
    const commands = await browser.commands.getAll();
    const byName = Object.fromEntries(commands.map((c) => [c.name, c.shortcut]));
    els.shortcutSave.textContent = byName["save-tab"] || "Not set";
    els.shortcutOpen.textContent = byName["open-picker"] || "Not set";
  }

  async function openShortcutsSettings() {
    // There is no cross-browser API to open the shortcuts editor, and the
    // internal settings URL differs (and is blocked outright in some
    // browsers/policies) — try the best-guess URL for this browser, and if
    // tabs.create rejects it, fall back to plain-text instructions instead
    // of leaving the button appearing to do nothing.
    const url = isFirefox() ? "about:addons" : "chrome://extensions/shortcuts";
    try {
      await browser.tabs.create({ url });
    } catch (err) {
      els.shortcutsFallback.hidden = false;
      els.shortcutsFallback.textContent = isFirefox()
        ? 'Open about:addons, click the gear icon, then "Manage Extension Shortcuts".'
        : "Open your browser's extensions page and look for a “Keyboard shortcuts” link.";
    }
  }

  async function loadSettings() {
    const state = await sendMessage("GET_STATE");
    const radios = document.querySelectorAll('input[name="clearOnOpen"]');
    const value = state.settings.clearOnOpen ? "clear" : "keep";
    for (const r of radios) {
      r.checked = r.value === value;
      r.addEventListener("change", onClearOnOpenChange);
    }
    renderStats(state);
  }

  async function onClearOnOpenChange(e) {
    if (!e.target.checked) return;
    await sendMessage("UPDATE_SETTINGS", { settings: { clearOnOpen: e.target.value === "clear" } });
  }

  function renderStats(state) {
    const groupCount = state.groups.length;
    const tabCount = state.groups.reduce((sum, g) => sum + g.tabs.length, 0);
    els.stats.textContent = `${groupCount} group${groupCount === 1 ? "" : "s"}, ${tabCount} saved tab${tabCount === 1 ? "" : "s"}.`;
  }

  async function onExport() {
    const state = await sendMessage("EXPORT_DATA");
    const json = JSON.stringify(state, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tab-stash-backup-${date}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    els.backupStatus.textContent = "Exported.";
  }

  function onImportClick() {
    els.importFile.value = "";
    els.importFile.click();
  }

  async function onImportFile() {
    const file = els.importFile.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.groups)) {
        throw new Error("File doesn't look like a Tab Stash backup.");
      }
      const result = await sendMessage("IMPORT_DATA", { data });
      els.backupStatus.textContent = `Imported. You now have ${result.groups.length} group(s).`;
      const state = await sendMessage("GET_STATE");
      renderStats(state);
    } catch (err) {
      els.backupStatus.textContent = `Import failed: ${err.message}`;
    }
  }

  async function init() {
    await loadShortcuts();
    await loadSettings();
    els.openShortcutsPage.addEventListener("click", openShortcutsSettings);
    els.exportBtn.addEventListener("click", onExport);
    els.importBtn.addEventListener("click", onImportClick);
    els.importFile.addEventListener("change", onImportFile);
  }

  init();
})();
