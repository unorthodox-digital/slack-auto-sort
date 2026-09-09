const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ME = "U1";
const OTHER = "U2";

function join(user, ts) {
  return { ts, user, text: "", subtype: "channel_join" };
}

function human(ts, text = "hello") {
  return { ts, user: OTHER, text };
}

function bot(ts, text = "bot says hi") {
  return { ts, user: "U3", text, bot_id: "B1" };
}

function mention(ts) {
  return { ts, user: OTHER, text: `hey <@${ME}>` };
}

function atChannel(ts) {
  return { ts, user: OTHER, text: "heads up <!channel>" };
}

// Slack returns unread messages newest-first. `chrono` is oldest → newest.
function newestFirst(chrono) {
  return chrono.slice().reverse();
}

function loadHooks() {
  const src = fs.readFileSync(path.join(__dirname, "..", "inject.js"), "utf8");
  const documentElement = {
    setAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener() {},
  };
  const sandbox = {
    __SLACK_AUTOSORT_TEST__: true,
    document: {
      documentElement,
      addEventListener() {},
    },
    localStorage: {
      getItem() {
        return null;
      },
    },
    MutationObserver: class MutationObserver {
      observe() {}
    },
    setTimeout() {
      return 0;
    },
    setInterval() {
      return 0;
    },
    console,
    fetch() {
      return Promise.resolve({ json: async () => ({ ok: false }) });
    },
    FormData,
    URL,
    window: { location: { pathname: "/" } },
    Object,
    Array,
    String,
    Number,
    Boolean,
    Date,
    Math,
    JSON,
    Promise,
    Set,
    Map,
    WeakMap,
    WeakSet,
    RegExp,
    Error,
    TypeError,
    parseFloat,
    parseInt,
    isNaN,
    Infinity,
    NaN,
    undefined,
    encodeURIComponent,
    decodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: "inject.js" });
  const hooks = sandbox.__slackAutoSortTestHooks;
  assert.ok(hooks, "inject.js did not export __slackAutoSortTestHooks");
  return hooks;
}

const hooks = loadHooks();

test("selectInviteTarget: [join(me)] → me.ts", () => {
  const meJoin = join(ME, "1.0");
  assert.equal(hooks.selectInviteTarget(newestFirst([meJoin]), ME), "1.0");
});

test("selectInviteTarget: [join(other), join(me)] → me.ts", () => {
  assert.equal(
    hooks.selectInviteTarget(newestFirst([join(OTHER, "1.0"), join(ME, "2.0")]), ME),
    "2.0"
  );
});

test("selectInviteTarget: [join(me), human] → me.ts", () => {
  assert.equal(
    hooks.selectInviteTarget(newestFirst([join(ME, "1.0"), human("2.0")]), ME),
    "1.0"
  );
});

test("selectInviteTarget: [join(me), join(other)] → me.ts", () => {
  assert.equal(
    hooks.selectInviteTarget(newestFirst([join(ME, "1.0"), join(OTHER, "2.0")]), ME),
    "1.0"
  );
});

test("selectInviteTarget: [human, join(me)] → null", () => {
  assert.equal(
    hooks.selectInviteTarget(newestFirst([human("1.0"), join(ME, "2.0")]), ME),
    null
  );
});

test("selectInviteTarget: [bot, join(me)] → null", () => {
  assert.equal(
    hooks.selectInviteTarget(newestFirst([bot("1.0"), join(ME, "2.0")]), ME),
    null
  );
});

test("selectInviteTarget: [] → null", () => {
  assert.equal(hooks.selectInviteTarget([], ME), null);
});

test("selectBroadcastTarget: [join, join] → second join ts", () => {
  assert.equal(
    hooks.selectBroadcastTarget(newestFirst([join(OTHER, "1.0"), join(ME, "2.0")]), ME, 0),
    "2.0"
  );
});

test("selectBroadcastTarget: [join, human] → join ts", () => {
  assert.equal(
    hooks.selectBroadcastTarget(newestFirst([join(OTHER, "1.0"), human("2.0")]), ME, 0),
    "1.0"
  );
});

test("selectBroadcastTarget: [human, join] → null", () => {
  assert.equal(
    hooks.selectBroadcastTarget(newestFirst([human("1.0"), join(OTHER, "2.0")]), ME, 0),
    null
  );
});

test("selectBroadcastTarget: [join, mention-of-me, join] → first join ts", () => {
  assert.equal(
    hooks.selectBroadcastTarget(
      newestFirst([join(OTHER, "1.0"), mention("2.0"), join(OTHER, "3.0")]),
      ME,
      1
    ),
    "1.0"
  );
});

test("selectBroadcastTarget: [at-channel, bot] → bot ts", () => {
  assert.equal(
    hooks.selectBroadcastTarget(newestFirst([atChannel("1.0"), bot("2.0")]), ME, 0),
    "2.0"
  );
});

test("selectBroadcastTarget: mentionCount 1 with no visible mention → null", () => {
  assert.equal(
    hooks.selectBroadcastTarget(newestFirst([join(OTHER, "1.0"), human("2.0")]), ME, 1),
    null
  );
});

test("selectBroadcastTarget: [] → null", () => {
  assert.equal(hooks.selectBroadcastTarget([], ME, 0), null);
});

test("forwardOnly: newer ts is forward", () => {
  assert.equal(hooks.forwardOnly("2.0", "1.0"), true);
});

test("forwardOnly: equal ts is not forward", () => {
  assert.equal(hooks.forwardOnly("1.0", "1.0"), false);
});

test("forwardOnly: older ts is not forward", () => {
  assert.equal(hooks.forwardOnly("0.5", "1.0"), false);
});
