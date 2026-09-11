const js = require("@eslint/js");
const globals = require("globals");

const webExtensionGlobals = {
  browser: "readonly",
  chrome: "readonly",
  importScripts: "readonly",
};

// storage.js is loaded via importScripts() into the same worker global scope
// as background.js (see the comment atop src/lib/storage.js), so its
// top-level function/const declarations become implicit globals there.
const storageGlobals = {
  getState: "readonly",
  setSettings: "readonly",
  createGroup: "readonly",
  renameGroup: "readonly",
  deleteGroup: "readonly",
  addTabToGroup: "readonly",
  deleteTabFromGroup: "readonly",
  reorderTabsInGroup: "readonly",
  replaceState: "readonly",
  mergeGroups: "readonly",
  GROUP_COLORS: "readonly",
};

module.exports = [
  js.configs.recommended,
  {
    ignores: ["dist-firefox/**", "node_modules/**", "src/lib/browser-polyfill.js"],
  },
  {
    files: ["eslint.config.js", "vitest.config.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["src/background.js"],
    languageOptions: {
      globals: { ...globals.serviceworker, ...webExtensionGlobals, ...storageGlobals },
    },
  },
  {
    files: ["src/lib/**/*.js"],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.node, ...webExtensionGlobals },
    },
  },
  {
    files: ["src/popup/**/*.js", "src/options/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser, ...webExtensionGlobals },
    },
  },
  {
    files: ["scripts/**/*.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["tests/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node, ...webExtensionGlobals },
    },
  },
  {
    rules: {
      "no-unused-vars": ["error", { caughtErrors: "none" }],
    },
  },
  require("eslint-config-prettier"),
];
