/**
 * The workspace-wide thread-clearing call must not exist in this codebase.
 *
 * Slack has a call that marks EVERY thread read at once. It needs no
 * arguments, which makes it trivially easy to fire by accident — that is
 * exactly how it was fired on 2026-08-20, as an "existence probe" with empty
 * arguments, wiping unread thread state that had to be recovered by hand.
 *
 * It would clear threads in every channel, including ones outside the three
 * approved prefixes and including replies naming Mher, and nothing undoes
 * it. Per-thread `subscriptions.thread.mark` is the only write this
 * extension is allowed to make.
 *
 * The banned name is assembled from fragments so this file does not contain
 * the literal it forbids, which lets the scan cover the whole repo including
 * its own tests.
 *
 * Run: node --test tests/
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const BANNED = "clear" + "All";
const BANNED_METHOD = "subscriptions.thread." + BANNED;

function trackedFiles() {
  const out = execFileSync("git", ["-C", REPO, "ls-files"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

test("the workspace-wide thread-clearing call appears nowhere in the source", () => {
  const offenders = [];
  for (const rel of trackedFiles()) {
    const full = path.join(REPO, rel);
    let body;
    try {
      body = fs.readFileSync(full, "utf8");
    } catch {
      continue;   // not a readable text file
    }
    if (body.includes(BANNED)) offenders.push(rel);
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `banned workspace-wide call found in: ${offenders.join(", ")}`
  );
});

test("the only thread write in the source is the per-thread mark", () => {
  const inject = fs.readFileSync(path.join(REPO, "inject.js"), "utf8");
  const calls = inject.match(/"subscriptions\.thread\.[a-zA-Z.]+"/g) || [];
  assert.deepStrictEqual(
    [...new Set(calls)],
    ['"subscriptions.thread.mark"'],
    "only subscriptions.thread.mark may appear"
  );
  assert.ok(!inject.includes(BANNED_METHOD));
});

test("the mark call stays switched off until it is verified live", () => {
  const inject = fs.readFileSync(path.join(REPO, "inject.js"), "utf8");
  assert.match(
    inject,
    /const THREAD_MARK_VERIFIED = false;/,
    "THREAD_MARK_VERIFIED must stay false until the live check is done"
  );
  assert.match(inject, /TODO\(pending Mher's go\)/, "the TODO must name what unblocks it");
});


// ── Packaging: a built zip must contain what the manifest requires ────────
//
// build.sh copies an explicit file list. It omitted thread-select.js while
// the manifest declared it, so a 1.4.0 build would have shipped without a
// required content script and the pass would have silently disabled itself.

test("a real build contains every script the manifest declares", () => {
  // Pattern-matching build.sh's text was not a guard: a commented-out `cp`,
  // a copy to the wrong destination, or one inside `if false` all passed it.
  // This runs the real script into a temp dir and reads the zip entries.
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "manifest.json"), "utf8"));
  const declared = manifest.content_scripts.flatMap((cs) => cs.js);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "slack-auto-sort-build-"));
  try {
    execFileSync("bash", ["build.sh"], {
      cwd: REPO,
      env: { ...process.env, OUT_DIR: out },
      stdio: "pipe",
    });
    const zip = path.join(out, `slack-auto-sort-v${manifest.version}.zip`);
    assert.ok(fs.existsSync(zip), `build produced no zip at ${zip}`);
    const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const missing = declared.filter((f) => !entries.includes(f));
    assert.deepStrictEqual(missing, [], `built zip is missing: ${missing.join(", ")}`);
    assert.ok(entries.includes("manifest.json"));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("the in-page build marker matches the manifest version", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "manifest.json"), "utf8"));
  const inject = fs.readFileSync(path.join(REPO, "inject.js"), "utf8");
  const marker = inject.match(/data-slack-autosort-version",\s*"([^"]+)"/);
  assert.ok(marker, "the build marker must exist");
  assert.strictEqual(
    marker[1],
    manifest.version,
    "build.sh derives only the archive name, so this marker drifts unless bumped"
  );
});
