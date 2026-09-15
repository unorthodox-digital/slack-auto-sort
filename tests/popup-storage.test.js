const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXISTING_RULES = [
  { prefix: "vsl-", section: "VSL" },
  { prefix: "systems-", section: "Systems" },
];
const EXISTING_AUTOREAD = ["vsl-"];
const EXISTING_INVITES = ["funnel-"];
const EXISTING_BROADCASTS = ["systems-"];

function fromVm(value) {
  return JSON.parse(JSON.stringify(value));
}

function unescapeHtml(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function makeDiv() {
  const state = {
    className: "",
    children: [],
    inputs: [],
    buttons: [],
    parent: null,
    textContent: "",
    innerHTML: "",
    onclick: null,
    checked: false,
    value: "",
  };
  const div = {
    get className() {
      return state.className;
    },
    set className(v) {
      state.className = v;
    },
    get children() {
      return state.children;
    },
    get textContent() {
      return state.textContent;
    },
    set textContent(v) {
      state.textContent = v;
    },
    get checked() {
      return state.checked;
    },
    set checked(v) {
      state.checked = !!v;
    },
    get value() {
      return state.value;
    },
    set value(v) {
      state.value = v;
    },
    get onclick() {
      return state.onclick;
    },
    set onclick(v) {
      state.onclick = v;
    },
    set innerHTML(html) {
      state.innerHTML = html;
      state.inputs = [];
      state.buttons = [];
      const inputRe = /<input\b([^>]*)>/gi;
      let m;
      while ((m = inputRe.exec(html))) {
        const attrs = m[1];
        const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || "";
        const id = (attrs.match(/id="([^"]*)"/) || [])[1] || "";
        const type = (attrs.match(/type="([^"]*)"/) || [])[1] || "text";
        const value = unescapeHtml((attrs.match(/value="([^"]*)"/) || [])[1] || "");
        const checked = /\bchecked\b/i.test(attrs);
        state.inputs.push({ className: cls, id, type, value, checked });
      }
      const btnRe = /<button\b([^>]*)>/gi;
      while ((m = btnRe.exec(html))) {
        const attrs = m[1];
        state.buttons.push({
          className: (attrs.match(/class="([^"]*)"/) || [])[1] || "",
          onclick: null,
        });
      }
    },
    get innerHTML() {
      return state.innerHTML;
    },
    querySelector(sel) {
      if (sel.startsWith(".")) {
        const cls = sel.slice(1);
        return (
          state.inputs.find((i) => i.className.split(/\s+/).includes(cls)) ||
          state.buttons.find((b) => b.className.split(/\s+/).includes(cls)) ||
          null
        );
      }
      if (sel.startsWith("#")) {
        const id = sel.slice(1);
        return state.inputs.find((i) => i.id === id) || null;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === ".rule") {
        return state.children.filter((c) => c.className.split(/\s+/).includes("rule"));
      }
      return [];
    },
    appendChild(child) {
      child._parent = this;
      state.children.push(child);
      return child;
    },
    remove() {
      const parent = div._parent;
      if (!parent) return;
      const sib = parent.children;
      const idx = sib.indexOf(div);
      if (idx >= 0) sib.splice(idx, 1);
    },
  };
  return div;
}

function loadPopup({ sync = {}, local = {} } = {}) {
  const syncStore = { ...sync };
  const localStore = { ...local };
  const syncWrites = [];
  const localWrites = [];
  const ids = {
    rules: makeDiv(),
    autoread: makeDiv(),
    "autoread-invites": makeDiv(),
    "autoread-broadcasts": makeDiv(),
    status: makeDiv(),
    "add-rule": makeDiv(),
    "add-autoread": makeDiv(),
    "add-autoread-invite": makeDiv(),
    "add-autoread-broadcast": makeDiv(),
    save: makeDiv(),
    "vsl-capacity-cleanup": makeDiv(),
    "last-result": makeDiv(),
  };
  ids["vsl-capacity-cleanup"].checked = false;

  const sandbox = {
    document: {
      getElementById(id) {
        return ids[id] || null;
      },
      createElement() {
        return makeDiv();
      },
    },
    chrome: {
      storage: {
        sync: {
          get(defaults, cb) {
            cb({ ...defaults, ...syncStore });
          },
          set(values, cb) {
            Object.assign(syncStore, values);
            syncWrites.push({ ...values });
            if (cb) cb();
          },
        },
        local: {
          get(defaults, cb) {
            cb({ ...defaults, ...localStore });
          },
          set(values, cb) {
            Object.assign(localStore, values);
            localWrites.push({ ...values });
            if (cb) cb();
          },
        },
        onChanged: {
          addListener() {},
        },
      },
    },
    setTimeout(fn) {
      return 0;
    },
    console,
    String,
    Array,
    Object,
    JSON,
    Boolean,
  };
  sandbox.globalThis = sandbox;
  const src = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
  vm.runInNewContext(src, sandbox, { filename: "popup.js" });
  return { ids, syncStore, localStore, syncWrites, localWrites };
}

test("load leaves existing saved settings untouched when the cleanup toggle key is missing", () => {
  const { ids, syncStore, syncWrites } = loadPopup({
    sync: {
      rules: EXISTING_RULES,
      autoReadPrefixes: EXISTING_AUTOREAD,
      autoReadInvitePrefixes: EXISTING_INVITES,
      autoReadBroadcastPrefixes: EXISTING_BROADCASTS,
    },
  });

  assert.equal(ids["vsl-capacity-cleanup"].checked, false);
  assert.deepEqual(syncStore, {
    rules: EXISTING_RULES,
    autoReadPrefixes: EXISTING_AUTOREAD,
    autoReadInvitePrefixes: EXISTING_INVITES,
    autoReadBroadcastPrefixes: EXISTING_BROADCASTS,
  });
  assert.deepEqual(syncWrites, []);
});

test("save persists the opt-in toggle without rewriting existing rules or auto-read lists", () => {
  const { ids, syncStore, syncWrites } = loadPopup({
    sync: {
      rules: EXISTING_RULES,
      autoReadPrefixes: EXISTING_AUTOREAD,
      autoReadInvitePrefixes: EXISTING_INVITES,
      autoReadBroadcastPrefixes: EXISTING_BROADCASTS,
    },
  });

  ids["vsl-capacity-cleanup"].checked = true;
  ids.save.onclick();

  assert.equal(syncWrites.length, 1);
  assert.equal(syncStore.vslCapacityCleanup, true);
  assert.deepEqual(fromVm(syncStore.rules), EXISTING_RULES);
  assert.deepEqual(fromVm(syncStore.autoReadPrefixes), EXISTING_AUTOREAD);
  assert.deepEqual(fromVm(syncStore.autoReadInvitePrefixes), EXISTING_INVITES);
  assert.deepEqual(fromVm(syncStore.autoReadBroadcastPrefixes), EXISTING_BROADCASTS);
});

test("load restores a saved-on cleanup toggle", () => {
  const { ids } = loadPopup({
    sync: {
      rules: EXISTING_RULES,
      autoReadPrefixes: EXISTING_AUTOREAD,
      autoReadInvitePrefixes: EXISTING_INVITES,
      autoReadBroadcastPrefixes: EXISTING_BROADCASTS,
      vslCapacityCleanup: true,
    },
  });
  assert.equal(ids["vsl-capacity-cleanup"].checked, true);
});

test("popup shows the latest stored full-section result without writing sync storage", () => {
  const { ids, syncWrites } = loadPopup({
    sync: { rules: EXISTING_RULES },
    local: {
      lastSortResult: {
        kind: "full",
        section: "VSL",
        waiting: 30,
        limit: 500,
      },
    },
  });
  assert.match(ids["last-result"].textContent, /VSL/);
  assert.match(ids["last-result"].textContent, /500/);
  assert.match(ids["last-result"].textContent, /30/);
  assert.deepEqual(syncWrites, []);
});

test("popup shows a stored cleanup result without writing sync storage", () => {
  const { ids, syncWrites } = loadPopup({
    sync: { rules: EXISTING_RULES },
    local: {
      lastSortResult: {
        kind: "cleanup",
        section: "VSL",
        left: 87,
        failed: 13,
        stoppedOnRateLimit: false,
      },
    },
  });
  assert.match(ids["last-result"].textContent, /87/);
  assert.match(ids["last-result"].textContent, /13/);
  assert.deepEqual(syncWrites, []);
});
