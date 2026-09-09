/**
 * The code floor: a pull request may not add an explicit `any`, and it may
 * not introduce a source file that is over 500 lines (or push a file across
 * that cap).
 *
 * It is a ratchet, not a repo-wide lint. On 7 Sep 2026 origin/main 4a1e97dd
 * had 986 occurrences of the word `any` across client/, server/ and shared/,
 * and 76 of 503 source files were already over 500 lines (server/routes.ts
 * is 9,296). A rule that scanned the whole tree would fail every pull
 * request. This script compares only the files the current change touches
 * against their version on the base branch, so existing violations stay
 * until someone edits that file and has to pay the floor.
 *
 * Run locally before committing: `npm run floor`, or
 * `node scripts/lint-floor.mjs`. CI runs it on pull_request against
 * origin/${{ github.base_ref }}.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_RE = /\.(tsx|mts|cts|ts|jsx|mjs|cjs|js)$/;
const TS_RE = /\.(tsx|mts|cts|ts)$/;
const IGNORE = ["node_modules/", "dist/", ".scratch/", ".d.ts"];

export function countLines(text) {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") n++;
  if (!text.endsWith("\n")) n++;
  return n;
}

function posix(p) {
  return p.replace(/\\/g, "/");
}

function isIgnored(file) {
  const p = posix(file);
  for (const entry of IGNORE) {
    if (entry.endsWith("/")) {
      if (p.startsWith(entry) || p.includes(`/${entry}`)) return true;
    } else if (entry.startsWith(".") && !entry.includes("/")) {
      if (p.endsWith(entry)) return true;
    } else if (p === entry) return true;
  }
  return false;
}

function tsApi(ts) {
  return ts.createSourceFile ? ts : ts.default;
}

export function anyLines(text, filename, ts) {
  const api = tsApi(ts);
  const kind = posix(filename).endsWith(".tsx") ? api.ScriptKind.TSX : api.ScriptKind.TS;
  const sf = api.createSourceFile(filename, text, api.ScriptTarget.Latest, true, kind);
  const physical = text.split("\n");
  const hits = [];
  const visit = (node) => {
    if (node.kind === api.SyntaxKind.AnyKeyword) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push({ line: line + 1, text: (physical[line] ?? "").trim() });
    }
    api.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function parseNameStatus(text, map) {
  for (const line of text.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const code = parts[0][0];
    if (code === "D") continue;
    if ((code === "R" || code === "C") && parts[2]) {
      map.set(parts[2], { path: parts[2], oldPath: parts[1] });
    } else if (parts[1] && !map.has(parts[1])) {
      map.set(parts[1], { path: parts[1], oldPath: parts[1] });
    }
  }
}

export function changedFiles(runGit, mergeBase) {
  const map = new Map();
  parseNameStatus(runGit(["diff", "--name-status", "-M", mergeBase]), map);
  parseNameStatus(runGit(["diff", "--name-status", "-M", "HEAD"]), map);
  for (const p of runGit(["ls-files", "--others", "--exclude-standard"]).split("\n")) {
    if (p && !map.has(p)) map.set(p, { path: p, oldPath: p });
  }
  return [...map.values()]
    .filter((f) => SOURCE_RE.test(f.path) && !isIgnored(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function diffAny(beforeLines, afterLines) {
  const bag = new Map();
  for (const e of beforeLines) bag.set(e.text, (bag.get(e.text) ?? 0) + 1);
  const fresh = [];
  for (const e of afterLines) {
    const n = bag.get(e.text) ?? 0;
    if (n > 0) bag.set(e.text, n - 1);
    else fresh.push(e);
  }
  return fresh;
}

export function judge(before, after, cap) {
  const findings = [];
  if (after.anyCount > before.anyCount) {
    findings.push({
      kind: "any", violation: true,
      fresh: diffAny(before.anyLines, after.anyLines),
      from: before.anyCount, to: after.anyCount,
    });
  }
  if (after.lines > cap && before.lines <= cap) {
    findings.push({ kind: "cap", violation: true, afterLines: after.lines, beforeLines: before.lines, cap });
  } else if (before.lines > cap && after.lines > cap) {
    findings.push({
      kind: "already-over", violation: false, grew: after.lines > before.lines,
      afterLines: after.lines, beforeLines: before.lines,
    });
  }
  return findings;
}

function snippet(text) {
  return text.length > 120 ? text.slice(0, 120) : text;
}

function formatFinding(filePath, f) {
  if (f.kind === "any") {
    if (f.fresh.length === 0) return [`${filePath}: explicit any count went from ${f.from} to ${f.to}`];
    return f.fresh.map((e) => `${filePath}:${e.line}: new explicit any: ${snippet(e.text)}`);
  }
  if (f.kind === "cap") return [`${filePath}: ${f.afterLines} lines, cap is ${f.cap} (was ${f.beforeLines})`];
  return [`${filePath}: already over the cap (${f.beforeLines} -> ${f.afterLines} lines), not counted`];
}

function measure(text, filename, ts) {
  const lines = countLines(text);
  if (!text || !TS_RE.test(posix(filename)) || !ts) return { lines, anyCount: 0, anyLines: [] };
  const hits = anyLines(text, filename, ts);
  return { lines, anyCount: hits.length, anyLines: hits };
}

function gitOut(root, args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function die(message) {
  console.error(`lint-floor: ${message}`);
  return 2;
}

function parseArgs(argv) {
  let base;
  let cap = 500;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("usage: --base <ref>");
      base = v;
    } else if (a === "--cap") {
      const v = argv[++i];
      const n = Number(v);
      if (!v || !Number.isFinite(n) || n < 0) throw new Error("usage: --cap <n>");
      cap = n;
    } else if (a === "--verbose") verbose = true;
    else throw new Error(`unknown option ${a}`);
  }
  return { base, cap, verbose };
}

export async function main(argv) {
  let parsed;
  try { parsed = parseArgs(argv); } catch (err) { return die(err.message); }
  const { cap, verbose } = parsed;
  let root;
  try { root = gitOut(process.cwd(), ["rev-parse", "--show-toplevel"]).trim(); }
  catch { return die("not a git repository"); }
  const runGit = (args) => gitOut(root, args).replace(/\n$/, "");
  let base = parsed.base ?? process.env.LINT_FLOOR_BASE;
  if (!base) {
    try { runGit(["rev-parse", "--verify", "-q", "origin/main"]); base = "origin/main"; }
    catch { base = "main"; }
  }
  try { runGit(["rev-parse", "--verify", "-q", base]); }
  catch { return die(`base ref ${base} is missing`); }
  let mergeBase;
  try { mergeBase = runGit(["merge-base", base, "HEAD"]); }
  catch { return die(`cannot find merge-base of ${base} and HEAD`); }

  const files = changedFiles(runGit, mergeBase);
  let ts = null;
  if (files.some((f) => TS_RE.test(posix(f.path)))) {
    try { ts = tsApi(await import("typescript")); }
    catch { return die("typescript is not installed, so the any check cannot run"); }
  }

  const short = runGit(["rev-parse", "--short", mergeBase]);
  let violations = 0;
  const out = [];
  for (const file of files) {
    let afterText;
    try { afterText = readFileSync(path.join(root, file.path), "utf8"); }
    catch { continue; }
    let beforeText = "";
    try { beforeText = gitOut(root, ["show", `${mergeBase}:${file.oldPath}`]); }
    catch { beforeText = ""; }
    const before = measure(beforeText, file.oldPath, ts);
    const after = measure(afterText, file.path, ts);
    if (verbose) {
      out.push(`${file.path}: lines ${before.lines} -> ${after.lines}, any ${before.anyCount} -> ${after.anyCount}`);
    }
    for (const f of judge(before, after, cap)) {
      if (f.kind === "already-over" && !f.grew && !verbose) continue;
      out.push(...formatFinding(file.path, f));
      if (f.violation) violations++;
    }
  }
  out.push(`lint-floor: ${files.length} files checked against ${base} (${short}), ${violations} new violations`);
  process.stdout.write(out.join("\n") + "\n");
  return violations > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => { console.error(`lint-floor: ${err.message}`); process.exit(2); },
  );
}
