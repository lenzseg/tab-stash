// Firefox needs its own manifest (background.scripts instead of
// background.service_worker), so this copies the shared source tree into
// dist-firefox/ and swaps in manifest.firefox.json as manifest.json,
// producing a folder that can be loaded directly via
// about:debugging#/runtime/this-firefox -> "Load Temporary Add-on".
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "dist-firefox");

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

copyRecursive(path.join(root, "src"), path.join(outDir, "src"));
copyRecursive(path.join(root, "icons"), path.join(outDir, "icons"));
fs.copyFileSync(path.join(root, "manifest.firefox.json"), path.join(outDir, "manifest.json"));

console.log(`Firefox build written to ${outDir}`);
