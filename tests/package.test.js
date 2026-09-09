const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

test("build zip matches manifest version and lists the six distribution files", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const inject = fs.readFileSync(path.join(ROOT, "inject.js"), "utf8");
  const marker = inject.match(/data-slack-autosort-version",\s*"([^"]+)"/);
  assert.ok(marker, "inject.js is missing the version marker");
  assert.equal(manifest.version, marker[1]);

  execFileSync("bash", ["build.sh"], { cwd: ROOT, encoding: "utf8" });

  const zipPath = path.join(ROOT, "dist", `slack-auto-sort-v${manifest.version}.zip`);
  assert.ok(fs.existsSync(zipPath), `expected ${zipPath} to exist`);

  const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(listing, [
    "README.md",
    "content.js",
    "inject.js",
    "manifest.json",
    "popup.html",
    "popup.js",
  ]);
});
