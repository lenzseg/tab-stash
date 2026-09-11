// Tab Stash background service worker.
//
// `importScripts` only exists inside a worker global scope, so it is only
// called on Chromium (service_worker background). On Firefox the same files
// are already loaded up-front via the "scripts" array in
// manifest.firefox.json (background pages there run in a window-like
// context, not a worker, so importScripts is unavailable there).
if (typeof importScripts === "function") {
  importScripts("lib/browser-polyfill.js", "lib/storage.js");
}

// Feature-detect the native Chromium tabGroups API rather than branching on
// browser name — this also degrades gracefully on any future/older browser
// that ships tabs.group()/tabGroups without being Chrome specifically.
function supportsTabGroups() {
  return !!(browser.tabGroups && browser.tabs.group);
}

async function openPickerWindow(params) {
  let left;
  let top;
  try {
    const currentWindow = await browser.windows.getCurrent();
    const width = 420;
    left = Math.max(0, (currentWindow.left || 0) + (currentWindow.width || 900) - width - 24);
    top = Math.max(0, (currentWindow.top || 0) + 60);
  } catch (err) {
    // windows.getCurrent can fail in odd focus states; fall back to letting
    // the browser choose a default position.
  }

  const query = new URLSearchParams(params).toString();
  await browser.windows.create({
    url: browser.runtime.getURL(`src/popup/popup.html?${query}`),
    type: "popup",
    width: 420,
    height: 540,
    left,
    top,
    focused: true,
  });
}

browser.commands.onCommand.addListener(async (command) => {
  if (command === "save-tab") {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    await openPickerWindow({
      mode: "save",
      tabId: String(tab.id),
      url: tab.url || "",
      title: tab.title || "",
      favIconUrl: tab.favIconUrl || "",
      pinned: tab.pinned ? "1" : "0",
    });
  } else if (command === "open-picker") {
    // Capture the window the shortcut was pressed in *before* opening the
    // quick-picker — the picker is itself a separate popup-type browser
    // window, so by the time the user picks a group, "the current window"
    // (as far as a naive windows.getCurrent() call would see it) would be
    // that small picker window, not the window we actually want to restore
    // tabs into.
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    await openPickerWindow({ mode: "open", windowId: tab ? String(tab.windowId) : "" });
  }
});

async function restoreGroup(groupId, clearOverride, windowId) {
  const { groups, settings } = await getState();
  const group = groups.find((g) => g.id === groupId);
  if (!group || group.tabs.length === 0) {
    return { opened: 0 };
  }

  const currentWindow = Number.isInteger(windowId)
    ? { id: windowId }
    : await browser.windows.getCurrent({ populate: false });
  const createdTabIds = [];

  if (supportsTabGroups()) {
    // Chromium: order among the created tabs doesn't matter here because
    // tabs.group() pulls its members together into one contiguous group
    // regardless of their current positions.
    for (let i = 0; i < group.tabs.length; i++) {
      const t = group.tabs[i];
      const tab = await browser.tabs.create({
        url: t.url,
        windowId: currentWindow.id,
        active: i === 0,
      });
      createdTabIds.push(tab.id);
    }
    try {
      const chromeGroupId = await browser.tabs.group({
        tabIds: createdTabIds,
        createProperties: { windowId: currentWindow.id },
      });
      await browser.tabGroups.update(chromeGroupId, {
        title: group.name,
        color: GROUP_COLORS.includes(group.color) ? group.color : "grey",
      });
    } catch (err) {
      // The tabs are already open even if the visual grouping call fails
      // (e.g. a transient extension-API error) — don't throw past this
      // point, just leave them ungrouped.
      console.warn("Tab Stash: tabs.group failed, tabs opened without native grouping", err);
    }
  } else {
    // Firefox (and any other browser without tabGroups): there is no native
    // grouping surface, so the best we can do is keep saved tabs adjacent
    // and in their saved order, opened right after the current tab, rather
    // than trusting the browser's default new-tab placement.
    const [activeTab] = await browser.tabs.query({ active: true, windowId: currentWindow.id });
    let insertIndex = activeTab ? activeTab.index + 1 : undefined;
    for (let i = 0; i < group.tabs.length; i++) {
      const t = group.tabs[i];
      const tab = await browser.tabs.create({
        url: t.url,
        windowId: currentWindow.id,
        index: insertIndex,
        active: i === 0,
      });
      createdTabIds.push(tab.id);
      if (typeof insertIndex === "number") insertIndex = tab.index + 1;
    }
  }

  const shouldClear = clearOverride !== undefined ? clearOverride : settings.clearOnOpen;
  if (shouldClear) {
    await deleteGroup(groupId);
  }

  return { opened: createdTabIds.length, cleared: shouldClear };
}

async function handleMessage(message) {
  switch (message.type) {
    case "GET_STATE":
      return getState();

    case "CREATE_GROUP":
      return createGroup(message.name, message.color);

    case "SAVE_TAB": {
      let groupId = message.groupId;
      if (!groupId) {
        const newGroup = await createGroup(message.newGroupName, message.newGroupColor);
        groupId = newGroup.id;
      }
      const group = await addTabToGroup(groupId, message.tab);
      let closed = false;
      // Pinned tabs are often long-lived utility tabs (mail, calendar); we
      // still save them, but we leave them open instead of closing them out
      // from under the user.
      if (!message.pinned && message.tabId) {
        try {
          await browser.tabs.remove(message.tabId);
          closed = true;
        } catch (err) {
          console.warn("Tab Stash: failed to close saved tab", err);
        }
      }
      return { group, closed };
    }

    case "RENAME_GROUP":
      return renameGroup(message.groupId, message.name);

    case "DELETE_GROUP":
      await deleteGroup(message.groupId);
      return { ok: true };

    case "DELETE_TAB":
      return deleteTabFromGroup(message.groupId, message.tabId);

    case "REORDER_TABS":
      return reorderTabsInGroup(message.groupId, message.fromIndex, message.toIndex);

    case "RESTORE_GROUP":
      return restoreGroup(message.groupId, message.clearOverride, message.windowId);

    case "UPDATE_SETTINGS":
      return setSettings(message.settings);

    case "EXPORT_DATA":
      return getState();

    case "IMPORT_DATA":
      return { groups: await mergeGroups(message.data && message.data.groups) };

    default:
      throw new Error(`Tab Stash: unknown message type "${message.type}"`);
  }
}

browser.runtime.onMessage.addListener((message) => handleMessage(message));

browser.runtime.onInstalled.addListener(async () => {
  const state = await getState();
  await replaceState(state); // normalizes defaults on first install/upgrade
});
