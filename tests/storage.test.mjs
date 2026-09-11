import { beforeEach, describe, expect, it } from "vitest";
import storage from "../src/lib/storage.js";

function makeFakeBrowser() {
  const backing = {};
  return {
    storage: {
      local: {
        async get(keys) {
          const result = {};
          for (const key of keys) {
            if (key in backing) result[key] = backing[key];
          }
          return result;
        },
        async set(values) {
          Object.assign(backing, values);
        },
      },
    },
  };
}

describe("storage", () => {
  beforeEach(() => {
    globalThis.browser = makeFakeBrowser();
  });

  it("starts with no groups and default settings", async () => {
    const state = await storage.getState();
    expect(state.groups).toEqual([]);
    expect(state.settings).toEqual({ clearOnOpen: false });
  });

  it("creates a group with a generated id and color", async () => {
    const group = await storage.createGroup("Work", undefined);
    expect(group.name).toBe("Work");
    expect(group.color).toBe("blue");
    expect(group.tabs).toEqual([]);

    const { groups } = await storage.getState();
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe(group.id);
  });

  it("falls back to 'New group' for a blank name", async () => {
    const group = await storage.createGroup("   ", undefined);
    expect(group.name).toBe("New group");
  });

  it("cycles through the color palette for successive groups", async () => {
    const a = await storage.createGroup("A");
    const b = await storage.createGroup("B");
    expect(a.color).toBe("blue");
    expect(b.color).toBe("red");
  });

  it("adds a tab to an existing group", async () => {
    const group = await storage.createGroup("Work");
    const updated = await storage.addTabToGroup(group.id, {
      url: "https://example.com",
      title: "Example",
    });
    expect(updated.tabs).toHaveLength(1);
    expect(updated.tabs[0].url).toBe("https://example.com");
  });

  it("throws when adding a tab to a missing group", async () => {
    await expect(
      storage.addTabToGroup("missing-id", { url: "https://example.com" }),
    ).rejects.toThrow("Group not found");
  });

  it("deletes a tab from a group", async () => {
    const group = await storage.createGroup("Work");
    const withTab = await storage.addTabToGroup(group.id, { url: "https://example.com" });
    const tabId = withTab.tabs[0].id;

    const result = await storage.deleteTabFromGroup(group.id, tabId);
    expect(result.tabs).toEqual([]);
  });

  it("deletes a group", async () => {
    const group = await storage.createGroup("Work");
    await storage.deleteGroup(group.id);
    const { groups } = await storage.getState();
    expect(groups).toEqual([]);
  });

  it("reorders tabs within a group", async () => {
    const group = await storage.createGroup("Work");
    await storage.addTabToGroup(group.id, { url: "https://a.com" });
    await storage.addTabToGroup(group.id, { url: "https://b.com" });
    const updated = await storage.addTabToGroup(group.id, { url: "https://c.com" });
    expect(updated.tabs.map((t) => t.url)).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
    ]);

    const reordered = await storage.reorderTabsInGroup(group.id, 0, 2);
    expect(reordered.tabs.map((t) => t.url)).toEqual([
      "https://b.com",
      "https://c.com",
      "https://a.com",
    ]);
  });

  it("ignores out-of-range reorder indexes", async () => {
    const group = await storage.createGroup("Work");
    await storage.addTabToGroup(group.id, { url: "https://a.com" });
    const result = await storage.reorderTabsInGroup(group.id, 0, 5);
    expect(result.tabs.map((t) => t.url)).toEqual(["https://a.com"]);
  });

  it("merges imported groups, dropping tabs without a url", async () => {
    await storage.createGroup("Existing");
    const merged = await storage.mergeGroups([
      {
        name: "Imported",
        color: "purple",
        tabs: [{ url: "https://ok.com", title: "OK" }, { title: "No URL" }],
      },
    ]);

    expect(merged).toHaveLength(2);
    const imported = merged.find((g) => g.name === "Imported");
    expect(imported.color).toBe("purple");
    expect(imported.tabs).toHaveLength(1);
    expect(imported.tabs[0].url).toBe("https://ok.com");
  });

  it("updates settings and merges with defaults", async () => {
    const settings = await storage.setSettings({ clearOnOpen: true });
    expect(settings).toEqual({ clearOnOpen: true });
    const { settings: stored } = await storage.getState();
    expect(stored).toEqual({ clearOnOpen: true });
  });
});
