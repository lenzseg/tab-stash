// Shared data-layer for Tab Stash. Loaded only inside the background service
// worker (via importScripts on Chromium, or the "scripts" array on Firefox) —
// all reads/writes to storage are funneled through the background context so
// there is a single writer and no read-modify-write races between the popup,
// options page, and background.
//
// Storage shape (chrome.storage.local):
// {
//   groups: [{ id, name, color, createdAt, updatedAt, tabs: [{ id, url, title, favIconUrl, savedAt }] }],
//   settings: { clearOnOpen: boolean }
// }

const STORAGE_KEY_GROUPS = "groups";
const STORAGE_KEY_SETTINGS = "settings";

const DEFAULT_SETTINGS = {
  clearOnOpen: false,
};

// Chromium's tabGroups.update() only accepts colors from this fixed palette.
const GROUP_COLORS = [
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
  "grey",
];

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function nextColor(existingGroups) {
  const used = existingGroups.length;
  return GROUP_COLORS[used % GROUP_COLORS.length];
}

async function getState() {
  const stored = await browser.storage.local.get([STORAGE_KEY_GROUPS, STORAGE_KEY_SETTINGS]);
  return {
    groups: Array.isArray(stored[STORAGE_KEY_GROUPS]) ? stored[STORAGE_KEY_GROUPS] : [],
    settings: { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY_SETTINGS] || {}) },
  };
}

async function setGroups(groups) {
  await browser.storage.local.set({ [STORAGE_KEY_GROUPS]: groups });
}

async function setSettings(settings) {
  const current = await getState();
  const merged = { ...current.settings, ...settings };
  await browser.storage.local.set({ [STORAGE_KEY_SETTINGS]: merged });
  return merged;
}

async function createGroup(name, color) {
  const { groups } = await getState();
  const group = {
    id: uid(),
    name: (name || "New group").trim() || "New group",
    color: color || nextColor(groups),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tabs: [],
  };
  groups.push(group);
  await setGroups(groups);
  return group;
}

async function renameGroup(groupId, name) {
  const { groups } = await getState();
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw new Error("Group not found");
  group.name = (name || "").trim() || group.name;
  group.updatedAt = Date.now();
  await setGroups(groups);
  return group;
}

async function deleteGroup(groupId) {
  const { groups } = await getState();
  const next = groups.filter((g) => g.id !== groupId);
  await setGroups(next);
}

async function addTabToGroup(groupId, tab) {
  const { groups } = await getState();
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw new Error("Group not found");
  group.tabs.push({
    id: uid(),
    url: tab.url,
    title: tab.title || tab.url,
    favIconUrl: tab.favIconUrl || "",
    savedAt: Date.now(),
  });
  group.updatedAt = Date.now();
  await setGroups(groups);
  return group;
}

async function deleteTabFromGroup(groupId, tabId) {
  const { groups } = await getState();
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw new Error("Group not found");
  group.tabs = group.tabs.filter((t) => t.id !== tabId);
  group.updatedAt = Date.now();
  await setGroups(groups);
  return group;
}

async function reorderTabsInGroup(groupId, fromIndex, toIndex) {
  const { groups } = await getState();
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw new Error("Group not found");
  if (
    fromIndex < 0 ||
    fromIndex >= group.tabs.length ||
    toIndex < 0 ||
    toIndex >= group.tabs.length
  ) {
    return group;
  }
  const [moved] = group.tabs.splice(fromIndex, 1);
  group.tabs.splice(toIndex, 0, moved);
  group.updatedAt = Date.now();
  await setGroups(groups);
  return group;
}

async function replaceState(newState) {
  const groups = Array.isArray(newState.groups) ? newState.groups : [];
  const settings = { ...DEFAULT_SETTINGS, ...(newState.settings || {}) };
  await browser.storage.local.set({
    [STORAGE_KEY_GROUPS]: groups,
    [STORAGE_KEY_SETTINGS]: settings,
  });
}

async function mergeGroups(importedGroups) {
  const { groups } = await getState();
  const withFreshIds = (importedGroups || []).map((g) => ({
    id: uid(),
    name: g.name || "Imported group",
    color: GROUP_COLORS.includes(g.color) ? g.color : nextColor(groups),
    createdAt: g.createdAt || Date.now(),
    updatedAt: Date.now(),
    tabs: (g.tabs || [])
      .filter((t) => t && t.url)
      .map((t) => ({
        id: uid(),
        url: t.url,
        title: t.title || t.url,
        favIconUrl: t.favIconUrl || "",
        savedAt: t.savedAt || Date.now(),
      })),
  }));
  const next = [...groups, ...withFreshIds];
  await setGroups(next);
  return next;
}
