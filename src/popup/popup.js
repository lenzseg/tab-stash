(function () {
  "use strict";

  // Kept in sync manually with the identical list in src/lib/storage.js —
  // the popup and the background worker run in separate script contexts
  // (no shared module) so this can't just be imported.
  const GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];
  const COLOR_HEX = {
    blue: "#4285f4",
    red: "#ea4335",
    yellow: "#fbbc04",
    green: "#34a853",
    pink: "#ff8bcb",
    purple: "#a142f4",
    cyan: "#24c1e0",
    orange: "#fa903e",
    grey: "#9aa0a6",
  };

  const qs = (id) => document.getElementById(id);

  const els = {
    app: qs("app"),
    tabnav: qs("tabnav"),
    openOptions: qs("openOptions"),
    viewPicker: qs("view-picker"),
    viewManage: qs("view-manage"),
    currentTabPreview: qs("currentTabPreview"),
    currentTabFavicon: qs("currentTabFavicon"),
    currentTabTitle: qs("currentTabTitle"),
    currentTabUrl: qs("currentTabUrl"),
    searchInput: qs("searchInput"),
    groupList: qs("groupList"),
    newGroupForm: qs("newGroupForm"),
    newGroupName: qs("newGroupName"),
    newGroupConfirm: qs("newGroupConfirm"),
    newGroupCancel: qs("newGroupCancel"),
    colorSwatches: qs("colorSwatches"),
    manageSearchInput: qs("manageSearchInput"),
    manageList: qs("manageList"),
    manageNewGroup: qs("manageNewGroup"),
    manageNewGroupForm: qs("manageNewGroupForm"),
    manageNewGroupName: qs("manageNewGroupName"),
    manageNewGroupConfirm: qs("manageNewGroupConfirm"),
    manageNewGroupCancel: qs("manageNewGroupCancel"),
    toast: qs("toast"),
  };

  function getQueryParams() {
    const params = new URLSearchParams(location.search);
    return Object.fromEntries(params.entries());
  }

  const params = getQueryParams();
  // mode: "save" / "open" -> a minimal quick-picker popup window opened by a
  // keyboard shortcut. No mode (icon click opened the browser action) -> the
  // full tabbed UI with Save + My Groups.
  const mode = params.mode === "save" || params.mode === "open" ? params.mode : "full";
  const isQuickPicker = mode !== "full";

  const pendingTab =
    mode === "save"
      ? {
          tabId: Number(params.tabId),
          url: params.url || "",
          title: params.title || "",
          favIconUrl: params.favIconUrl || "",
          pinned: params.pinned === "1",
        }
      : null;

  let state = { groups: [], settings: {} };
  let searchTerm = "";
  let selectedIndex = 0;
  let currentEntries = [];
  let selectedColor = GROUP_COLORS[0];
  let manageSearchTerm = "";
  let expandedGroupId = null;
  // The window to restore tabs into. Resolved once at load time (rather than
  // trusting the background's own windows.getCurrent() at click time) since
  // the quick-picker itself can be a separate popup-type window — by the
  // time the user picks a group, "current window" from the background's
  // perspective could otherwise resolve to that small picker window.
  let restoreWindowId = mode === "open" && params.windowId ? Number(params.windowId) : undefined;

  function sendMessage(type, payload) {
    return browser.runtime.sendMessage({ type, ...payload });
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => {
      els.toast.hidden = true;
    }, 1600);
  }

  function closeSelfSoon(delay) {
    window.setTimeout(() => window.close(), delay);
  }

  function formatRelativeTime(ts) {
    const diff = Date.now() - ts;
    const min = 60 * 1000;
    const hour = 60 * min;
    const day = 24 * hour;
    if (diff < min) return "just now";
    if (diff < hour) return `${Math.floor(diff / min)}m ago`;
    if (diff < day) return `${Math.floor(diff / hour)}h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function faviconOrFallback(url) {
    return url && (url.startsWith("http") || url.startsWith("data:image")) ? url : "";
  }

  // ---------- Init ----------

  async function init() {
    if (isQuickPicker) {
      els.tabnav.hidden = true;
    } else {
      els.tabnav.hidden = false;
      els.tabnav.addEventListener("click", (e) => {
        const btn = e.target.closest(".tabnav-btn");
        if (!btn) return;
        switchView(btn.dataset.view);
      });
    }

    if (mode === "open") {
      // Restoring only: no point offering to save the (non-existent) current
      // tab, and no point offering to create a brand-new empty group.
      els.currentTabPreview.hidden = true;
    } else if (mode === "save") {
      els.currentTabPreview.hidden = false;
      els.currentTabFavicon.src = faviconOrFallback(pendingTab.favIconUrl);
      els.currentTabTitle.textContent = pendingTab.title || pendingTab.url;
      els.currentTabUrl.textContent = pendingTab.url;
    } else {
      // full mode: popup opened by clicking the toolbar icon — look up the
      // active tab of the window the popup belongs to.
      els.currentTabPreview.hidden = true;
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          pendingTabFull = {
            tabId: tab.id,
            url: tab.url || "",
            title: tab.title || "",
            favIconUrl: tab.favIconUrl || "",
            pinned: !!tab.pinned,
          };
          restoreWindowId = tab.windowId;
          els.currentTabPreview.hidden = false;
          els.currentTabFavicon.src = faviconOrFallback(pendingTabFull.favIconUrl);
          els.currentTabTitle.textContent = pendingTabFull.title || pendingTabFull.url;
          els.currentTabUrl.textContent = pendingTabFull.url;
        }
      } catch (err) {
        // No accessible active tab (e.g. a privileged page) — saving is
        // simply unavailable this time; the picker still works for restoring.
      }
    }

    buildColorSwatches();

    state = await sendMessage("GET_STATE");
    renderPickerList();
    if (!isQuickPicker) renderManageList();

    wireEvents();
    els.searchInput.focus();
  }

  let pendingTabFull = null;

  function activeTabDescriptor() {
    return mode === "save" ? pendingTab : pendingTabFull;
  }

  function switchView(view) {
    const isSave = view === "save";
    els.viewPicker.hidden = !isSave;
    els.viewManage.hidden = isSave;
    for (const btn of els.tabnav.querySelectorAll(".tabnav-btn")) {
      btn.classList.toggle("is-active", btn.dataset.view === view);
    }
    if (isSave) {
      els.searchInput.focus();
    } else {
      renderManageList();
      els.manageSearchInput.focus();
    }
  }

  // ---------- Picker (save / open) view ----------

  function buildColorSwatches() {
    els.colorSwatches.innerHTML = "";
    for (const color of GROUP_COLORS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "color-swatch" + (color === selectedColor ? " is-selected" : "");
      btn.style.background = COLOR_HEX[color];
      btn.title = color;
      btn.addEventListener("click", () => {
        selectedColor = color;
        for (const s of els.colorSwatches.children) s.classList.remove("is-selected");
        btn.classList.add("is-selected");
      });
      els.colorSwatches.appendChild(btn);
    }
  }

  function filteredGroups() {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return state.groups;
    return state.groups.filter((g) => g.name.toLowerCase().includes(term));
  }

  function renderPickerList() {
    const groups = filteredGroups();
    const showNewGroupOption = mode !== "open";

    currentEntries = groups.map((g) => ({ type: "group", group: g }));
    if (showNewGroupOption) currentEntries.push({ type: "new" });

    if (selectedIndex >= currentEntries.length) selectedIndex = Math.max(0, currentEntries.length - 1);

    els.groupList.innerHTML = "";

    if (currentEntries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No groups yet.";
      els.groupList.appendChild(empty);
      return;
    }

    currentEntries.forEach((entry, index) => {
      const li = document.createElement("li");
      li.className = "group-item" + (index === selectedIndex ? " is-selected" : "");
      li.setAttribute("role", "option");

      if (entry.type === "new") {
        li.classList.add("new-group-item");
        li.textContent = "+ New group";
      } else {
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.background = COLOR_HEX[entry.group.color] || COLOR_HEX.grey;
        const name = document.createElement("span");
        name.className = "group-name";
        name.textContent = entry.group.name;
        const count = document.createElement("span");
        count.className = "group-count";
        count.textContent = String(entry.group.tabs.length);
        li.append(swatch, name, count);
      }

      li.addEventListener("click", () => {
        selectedIndex = index;
        activateSelected();
      });
      els.groupList.appendChild(li);
    });

    const selectedEl = els.groupList.children[selectedIndex];
    if (selectedEl) selectedEl.scrollIntoView({ block: "nearest" });
  }

  function moveSelection(delta) {
    if (currentEntries.length === 0) return;
    selectedIndex = (selectedIndex + delta + currentEntries.length) % currentEntries.length;
    renderPickerList();
  }

  function activateSelected() {
    const entry = currentEntries[selectedIndex];
    if (!entry) return;
    if (entry.type === "new") {
      openNewGroupForm();
    } else if (mode === "open") {
      restoreGroup(entry.group.id);
    } else {
      saveActiveTabToGroup(entry.group.id);
    }
  }

  function openNewGroupForm() {
    els.newGroupForm.hidden = false;
    els.newGroupName.value = "";
    els.newGroupName.focus();
  }

  function closeNewGroupForm() {
    els.newGroupForm.hidden = true;
  }

  async function saveActiveTabToGroup(groupId) {
    const tab = activeTabDescriptor();
    if (!tab || !tab.url) {
      showToast("No active tab to save");
      return;
    }
    const result = await sendMessage("SAVE_TAB", {
      groupId,
      tab: { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl },
      tabId: tab.tabId,
      pinned: tab.pinned,
    });
    const name = result && result.group ? result.group.name : "group";
    showToast(tab.pinned ? `Saved to "${name}" (pinned tab left open)` : `Saved to "${name}"`);
    if (isQuickPicker) {
      closeSelfSoon(750);
    } else {
      state = await sendMessage("GET_STATE");
      renderPickerList();
      renderManageList();
    }
  }

  async function createGroupAndSaveTab() {
    const name = els.newGroupName.value.trim();
    if (!name) {
      els.newGroupName.focus();
      return;
    }
    const tab = activeTabDescriptor();
    if (!tab || !tab.url) {
      showToast("No active tab to save");
      return;
    }
    const result = await sendMessage("SAVE_TAB", {
      groupId: null,
      newGroupName: name,
      newGroupColor: selectedColor,
      tab: { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl },
      tabId: tab.tabId,
      pinned: tab.pinned,
    });
    const groupName = result && result.group ? result.group.name : name;
    showToast(tab.pinned ? `Saved to "${groupName}" (pinned tab left open)` : `Saved to "${groupName}"`);
    closeNewGroupForm();
    if (isQuickPicker) {
      closeSelfSoon(750);
    } else {
      state = await sendMessage("GET_STATE");
      renderPickerList();
      renderManageList();
    }
  }

  async function restoreGroup(groupId) {
    const result = await sendMessage("RESTORE_GROUP", { groupId, windowId: restoreWindowId });
    if (!result || result.opened === 0) {
      showToast("That group has no tabs");
      return;
    }
    showToast(`Opened ${result.opened} tab${result.opened === 1 ? "" : "s"}`);
    if (isQuickPicker) {
      closeSelfSoon(750);
    } else {
      state = await sendMessage("GET_STATE");
      renderPickerList();
      renderManageList();
    }
  }

  // ---------- Manage view ----------

  function filteredManageGroups() {
    const term = manageSearchTerm.trim().toLowerCase();
    if (!term) return state.groups;
    return state.groups.filter((g) => g.name.toLowerCase().includes(term));
  }

  function renderManageList() {
    const groups = filteredManageGroups();
    els.manageList.innerHTML = "";

    if (groups.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No groups yet. Save a tab to get started.";
      els.manageList.appendChild(empty);
      return;
    }

    for (const group of groups) {
      els.manageList.appendChild(buildManageGroupEl(group));
    }
  }

  function buildManageGroupEl(group) {
    const wrap = document.createElement("li");
    wrap.className = "manage-group";

    const row = document.createElement("div");
    row.className = "manage-group-row";

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = COLOR_HEX[group.color] || COLOR_HEX.grey;

    const meta = document.createElement("div");
    meta.className = "manage-group-meta";
    const nameEl = document.createElement("span");
    nameEl.className = "manage-group-name";
    nameEl.textContent = group.name;
    const sub = document.createElement("div");
    sub.className = "manage-group-sub";
    sub.textContent = `${group.tabs.length} tab${group.tabs.length === 1 ? "" : "s"} · updated ${formatRelativeTime(group.updatedAt)}`;
    meta.append(nameEl, sub);

    const actions = document.createElement("div");
    actions.className = "manage-group-actions";

    const restoreBtn = mkMiniBtn("▶", "Open this group", () => restoreGroup(group.id));
    const renameBtn = mkMiniBtn("✎", "Rename", () => startRename(nameEl, meta, group));
    const deleteBtn = mkArmedDeleteBtn(group);
    actions.append(restoreBtn, renameBtn, deleteBtn);

    row.append(swatch, meta, actions);
    row.addEventListener("click", (e) => {
      if (e.target.closest(".mini-btn") || e.target.closest("input")) return;
      expandedGroupId = expandedGroupId === group.id ? null : group.id;
      renderManageList();
    });

    wrap.appendChild(row);

    if (expandedGroupId === group.id) {
      wrap.appendChild(buildTabsList(group));
    }

    return wrap;
  }

  function mkMiniBtn(label, title, onClick, danger) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini-btn" + (danger ? " danger" : "");
    btn.title = title;
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  function startRename(nameEl, meta, group) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "manage-group-name-input";
    input.value = group.name;
    meta.replaceChild(input, nameEl);
    input.focus();
    input.select();

    const commit = async () => {
      const newName = input.value.trim();
      if (newName && newName !== group.name) {
        await sendMessage("RENAME_GROUP", { groupId: group.id, name: newName });
        state = await sendMessage("GET_STATE");
      }
      renderManageList();
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") {
        input.value = group.name;
        input.blur();
      }
    });
    input.addEventListener("blur", commit, { once: true });
  }

  async function onDeleteGroup(group) {
    await sendMessage("DELETE_GROUP", { groupId: group.id });
    state = await sendMessage("GET_STATE");
    if (expandedGroupId === group.id) expandedGroupId = null;
    renderManageList();
    renderPickerList();
  }

  // window.confirm()/prompt() don't reliably work inside a Chrome extension
  // action popup (the dialog can be silently blocked), so deletion uses a
  // tap-to-arm / tap-to-confirm pattern on the button itself instead of a
  // native confirm dialog.
  function mkArmedDeleteBtn(group) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini-btn danger";
    btn.title = "Delete group";
    btn.textContent = "🗑";
    let armed = false;
    let disarmTimer = null;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        btn.textContent = "Confirm?";
        btn.title = "Click again to permanently delete this group";
        disarmTimer = window.setTimeout(() => {
          armed = false;
          btn.textContent = "🗑";
          btn.title = "Delete group";
        }, 3000);
      } else {
        window.clearTimeout(disarmTimer);
        onDeleteGroup(group);
      }
    });

    return btn;
  }

  function buildTabsList(group) {
    const list = document.createElement("ul");
    list.className = "manage-tabs";

    group.tabs.forEach((tab, index) => {
      const row = document.createElement("li");
      row.className = "manage-tab-row";

      const favicon = document.createElement("img");
      favicon.className = "favicon";
      favicon.alt = "";
      favicon.src = faviconOrFallback(tab.favIconUrl);

      const title = document.createElement("span");
      title.className = "manage-tab-title";
      title.textContent = tab.title || tab.url;
      title.title = tab.url;

      const actions = document.createElement("div");
      actions.className = "manage-tab-actions";
      if (index > 0) {
        actions.appendChild(
          mkMiniBtn("▲", "Move up", () => reorderTab(group.id, index, index - 1))
        );
      }
      if (index < group.tabs.length - 1) {
        actions.appendChild(
          mkMiniBtn("▼", "Move down", () => reorderTab(group.id, index, index + 1))
        );
      }
      actions.appendChild(mkMiniBtn("✕", "Remove tab", () => removeTab(group.id, tab.id), true));

      row.append(favicon, title, actions);
      list.appendChild(row);
    });

    return list;
  }

  async function reorderTab(groupId, fromIndex, toIndex) {
    await sendMessage("REORDER_TABS", { groupId, fromIndex, toIndex });
    state = await sendMessage("GET_STATE");
    renderManageList();
  }

  async function removeTab(groupId, tabId) {
    await sendMessage("DELETE_TAB", { groupId, tabId });
    state = await sendMessage("GET_STATE");
    renderManageList();
    renderPickerList();
  }

  // ---------- Wiring ----------

  function wireEvents() {
    els.searchInput.addEventListener("input", () => {
      searchTerm = els.searchInput.value;
      selectedIndex = 0;
      renderPickerList();
    });

    els.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        activateSelected();
      } else if (e.key === "Escape" && isQuickPicker) {
        window.close();
      }
    });

    els.newGroupName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        createGroupAndSaveTab();
      } else if (e.key === "Escape") {
        closeNewGroupForm();
        els.searchInput.focus();
      }
    });
    els.newGroupConfirm.addEventListener("click", createGroupAndSaveTab);
    els.newGroupCancel.addEventListener("click", () => {
      closeNewGroupForm();
      els.searchInput.focus();
    });

    els.manageSearchInput.addEventListener("input", () => {
      manageSearchTerm = els.manageSearchInput.value;
      renderManageList();
    });

    els.manageNewGroup.addEventListener("click", () => {
      els.manageNewGroupForm.hidden = false;
      els.manageNewGroupName.value = "";
      els.manageNewGroupName.focus();
    });

    async function confirmManageNewGroup() {
      const name = els.manageNewGroupName.value.trim();
      if (!name) {
        els.manageNewGroupName.focus();
        return;
      }
      await sendMessage("CREATE_GROUP", { name });
      state = await sendMessage("GET_STATE");
      els.manageNewGroupForm.hidden = true;
      renderManageList();
      renderPickerList();
    }

    els.manageNewGroupConfirm.addEventListener("click", confirmManageNewGroup);
    els.manageNewGroupCancel.addEventListener("click", () => {
      els.manageNewGroupForm.hidden = true;
    });
    els.manageNewGroupName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmManageNewGroup();
      } else if (e.key === "Escape") {
        els.manageNewGroupForm.hidden = true;
      }
    });

    els.openOptions.addEventListener("click", () => {
      browser.runtime.openOptionsPage();
    });
  }

  init();
})();
