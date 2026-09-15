const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fromVm(value) {
  return JSON.parse(JSON.stringify(value));
}

function cid(n) {
  return `C${String(n).padStart(4, "0")}`;
}

// Worked from mixedVslAtLimit(): eligible vsl- members of standard VSL are
// C0001–C0120 (created 1–120) and C0201–C0500 (created 201–500). Archived,
// wrong-prefix, outsider, and pseudo-section channels are ineligible even
// when older. Oldest 100 eligible by created, then id: C0001–C0100.
const EXPECTED_OLDEST_100 = [
  "C0001", "C0002", "C0003", "C0004", "C0005", "C0006", "C0007", "C0008", "C0009", "C0010",
  "C0011", "C0012", "C0013", "C0014", "C0015", "C0016", "C0017", "C0018", "C0019", "C0020",
  "C0021", "C0022", "C0023", "C0024", "C0025", "C0026", "C0027", "C0028", "C0029", "C0030",
  "C0031", "C0032", "C0033", "C0034", "C0035", "C0036", "C0037", "C0038", "C0039", "C0040",
  "C0041", "C0042", "C0043", "C0044", "C0045", "C0046", "C0047", "C0048", "C0049", "C0050",
  "C0051", "C0052", "C0053", "C0054", "C0055", "C0056", "C0057", "C0058", "C0059", "C0060",
  "C0061", "C0062", "C0063", "C0064", "C0065", "C0066", "C0067", "C0068", "C0069", "C0070",
  "C0071", "C0072", "C0073", "C0074", "C0075", "C0076", "C0077", "C0078", "C0079", "C0080",
  "C0081", "C0082", "C0083", "C0084", "C0085", "C0086", "C0087", "C0088", "C0089", "C0090",
  "C0091", "C0092", "C0093", "C0094", "C0095", "C0096", "C0097", "C0098", "C0099", "C0100",
];

function mixedVslAtLimit() {
  const vslIds = [];
  const channels = [];

  for (let n = 1; n <= 120; n++) {
    const id = cid(n);
    vslIds.push(id);
    channels.push({ id, name: `vsl-keep-${n}`, created: n, is_archived: false });
  }
  for (let n = 121; n <= 140; n++) {
    const id = cid(n);
    vslIds.push(id);
    channels.push({ id, name: `vsl-arch-${n}`, created: 0, is_archived: true });
  }
  for (let n = 141; n <= 200; n++) {
    const id = cid(n);
    vslIds.push(id);
    channels.push({ id, name: `other-${n}`, created: 0, is_archived: false });
  }
  for (let n = 201; n <= 500; n++) {
    const id = cid(n);
    vslIds.push(id);
    channels.push({ id, name: `vsl-new-${n}`, created: n, is_archived: false });
  }
  channels.push({ id: "C9001", name: "vsl-outsider", created: 0, is_archived: false });
  channels.push({ id: "C9002", name: "vsl-pseudo", created: 0, is_archived: false });

  const sections = [
    {
      type: "standard",
      name: "VSL",
      channel_section_id: "S-VSL",
      channel_ids_page: { channel_ids: vslIds, count: 500 },
    },
    {
      type: "starred",
      name: "VSL",
      channel_section_id: "S-FAKE",
      channel_ids_page: { channel_ids: ["C9002"], count: 1 },
    },
    {
      type: "standard",
      name: "Systems",
      channel_section_id: "S-SYS",
      channel_ids_page: { channel_ids: ["C9001"], count: 1 },
    },
  ];
  return { sections, channels };
}

function loadHooks() {
  const src = fs.readFileSync(path.join(__dirname, "..", "inject.js"), "utf8");
  const attrs = {};
  const documentElement = {
    setAttribute(k, v) {
      attrs[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
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
    setTimeout(fn) {
      if (typeof fn === "function") fn();
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
  return { hooks, sandbox, attrs, documentElement };
}

const { hooks } = loadHooks();

test("planner selects the oldest 100 eligible vsl- IDs when standard VSL is at 500", () => {
  const { sections, channels } = mixedVslAtLimit();
  const plan = fromVm(hooks.planVslCapacityCleanup(sections, channels, true));
  assert.deepEqual(plan.leaveIds, EXPECTED_OLDEST_100);
});

test("planner returns no IDs when fewer than 100 eligible channels sit in VSL", () => {
  const { sections, channels } = mixedVslAtLimit();
  const vsl = sections[0];
  const keep = new Set();
  for (let n = 1; n <= 99; n++) keep.add(cid(n));
  vsl.channel_ids_page.channel_ids = vsl.channel_ids_page.channel_ids.map((id) => id);
  const channels99 = channels.map((ch) => {
    if (keep.has(ch.id)) return ch;
    if (ch.name && ch.name.startsWith("vsl-") && !ch.is_archived && vsl.channel_ids_page.channel_ids.includes(ch.id)) {
      return { ...ch, name: `other-${ch.id}` };
    }
    return ch;
  });
  const plan = fromVm(hooks.planVslCapacityCleanup(sections, channels99, true));
  assert.deepEqual(plan.leaveIds, []);
});

test("planner returns no IDs when the cleanup toggle is off", () => {
  const { sections, channels } = mixedVslAtLimit();
  const plan = fromVm(hooks.planVslCapacityCleanup(sections, channels, false));
  assert.deepEqual(plan.leaveIds, []);
});

test("planner returns no IDs when VSL is under the 500-channel limit", () => {
  const { sections, channels } = mixedVslAtLimit();
  sections[0].channel_ids_page.count = 499;
  sections[0].channel_ids_page.channel_ids = sections[0].channel_ids_page.channel_ids.slice(0, 499);
  const plan = fromVm(hooks.planVslCapacityCleanup(sections, channels, true));
  assert.deepEqual(plan.leaveIds, []);
});

test("planner proceeds when section count exceeds returned IDs but 100+ eligible are confirmed", () => {
  const { sections, channels } = mixedVslAtLimit();
  sections[0].channel_ids_page.channel_ids = sections[0].channel_ids_page.channel_ids.slice(0, 480);
  sections[0].channel_ids_page.count = 500;
  const plan = fromVm(hooks.planVslCapacityCleanup(sections, channels, true));
  assert.deepEqual(plan.leaveIds, EXPECTED_OLDEST_100);
  assert.equal(plan.skipReason, undefined);
});

test("planner fails closed with insufficient_eligible when truncated IDs yield fewer than 100 eligible", () => {
  const { sections, channels } = mixedVslAtLimit();
  sections[0].channel_ids_page.channel_ids = sections[0].channel_ids_page.channel_ids.slice(0, 150);
  sections[0].channel_ids_page.count = 500;
  const channels150 = channels.map((ch) => {
    if (ch.name && ch.name.startsWith("vsl-") && !ch.is_archived && Number(ch.created) > 50) {
      return { ...ch, name: `other-${ch.id}` };
    }
    return ch;
  });
  const plan = fromVm(hooks.planVslCapacityCleanup(sections, channels150, true));
  assert.deepEqual(plan.leaveIds, []);
  assert.equal(plan.skipReason, "insufficient_eligible");
  assert.equal(plan.eligibleCount, 50);
  assert.equal(plan.requiredBatch, 100);
});

test("planner tie-breaks equal created timestamps by channel id", () => {
  const vslIds = [];
  const channels = [];
  for (let n = 100; n >= 1; n--) {
    const id = cid(n);
    vslIds.push(id);
    channels.push({ id, name: `vsl-tie-${n}`, created: 42, is_archived: false });
  }
  while (vslIds.length < 500) {
    const n = vslIds.length + 1;
    const id = `X${String(n).padStart(4, "0")}`;
    vslIds.push(id);
    channels.push({ id, name: `other-${n}`, created: 1, is_archived: false });
  }
  const sections = [
    {
      type: "standard",
      name: "VSL",
      channel_section_id: "S-VSL",
      channel_ids_page: { channel_ids: vslIds, count: 500 },
    },
  ];
  const plan = fromVm(hooks.planVslCapacityCleanup(sections, channels, true));
  assert.deepEqual(plan.leaveIds, EXPECTED_OLDEST_100);
});

test("planner never selects an unknown-age vsl- channel and fails closed below 100 known-age", () => {
  const unknown = [
    { id: "UAGE1", name: "vsl-missing-created" },
    { id: "UAGE2", name: "vsl-nan-created", created: Number.NaN },
    { id: "UAGE3", name: "vsl-zero-created", created: 0 },
    { id: "UAGE4", name: "vsl-neg-created", created: -5 },
    { id: "UAGE5", name: "vsl-inf-created", created: Number.POSITIVE_INFINITY },
  ];
  const unknownIds = unknown.map((ch) => ch.id);
  const vslIds = unknown.map((ch) => ch.id);
  const channels = unknown.map((ch) => ({ ...ch, is_archived: false }));
  for (let n = 1; n <= 99; n++) {
    const id = cid(n);
    vslIds.push(id);
    channels.push({ id, name: `vsl-keep-${n}`, created: n, is_archived: false });
  }
  while (vslIds.length < 500) {
    const n = vslIds.length + 1;
    const id = `Z${String(n).padStart(4, "0")}`;
    vslIds.push(id);
    channels.push({ id, name: `other-${n}`, created: 1, is_archived: false });
  }
  const sections = [
    {
      type: "standard",
      name: "VSL",
      channel_section_id: "S-VSL",
      channel_ids_page: { channel_ids: vslIds, count: 500 },
    },
  ];
  const plan = fromVm(hooks.planVslCapacityCleanup(sections, channels, true));
  assert.deepEqual(plan.leaveIds, []);
  for (const id of unknownIds) {
    assert.equal(plan.leaveIds.includes(id), false);
  }
});

const WAITING = [
  { id: "W0001", name: "vsl-waiting-a", created: 9000, is_archived: false },
  { id: "W0002", name: "vsl-waiting-b", created: 9001, is_archived: false },
];

function apiMethod(url) {
  const u = new URL(String(url));
  const i = u.pathname.indexOf("/api/");
  return i >= 0 ? u.pathname.slice(i + 5) : "";
}

function json(obj) {
  return { json: async () => obj };
}

async function runPollOnce({
  leaveErrors = {},
  cleanupEnabled = true,
  extraChannels = WAITING,
  eligibleRename = null,
} = {}) {
  const { hooks: pollHooks, sandbox, attrs } = loadHooks();
  const fixture = mixedVslAtLimit();
  if (eligibleRename) eligibleRename(fixture);
  const allChannels = fixture.channels.concat(extraChannels);
  const left = new Set();
  const calls = [];
  const logs = [];
  sandbox.console = {
    log: (...a) => logs.push(a.map(String).join(" ")),
    warn: (...a) => logs.push(a.map(String).join(" ")),
  };
  attrs["data-slack-autosort-rules"] = JSON.stringify([{ prefix: "vsl-", section: "VSL" }]);
  attrs["data-slack-autosort-vsl-capacity-cleanup"] = cleanupEnabled ? "true" : "false";

  sandbox.fetch = async (url, opts) => {
    const method = apiMethod(url);
    const body = opts && opts.body;
    const channel = body && body.get ? body.get("channel") : null;
    const insert = body && body.get ? body.get("insert") : null;
    const limit = body && body.get ? body.get("limit") : null;
    calls.push({ method, channel, insert, limit });

    if (method === "users.channelSections.list") {
      const remaining = fixture.sections[0].channel_ids_page.channel_ids.filter((id) => !left.has(id));
      const sections = fixture.sections.map((s, i) => {
        if (i !== 0) return s;
        return {
          ...s,
          channel_ids_page: { channel_ids: remaining, count: remaining.length },
        };
      });
      return json({ ok: true, channel_sections: sections });
    }
    if (method === "users.conversations") {
      return json({
        ok: true,
        channels: allChannels.filter((ch) => !left.has(ch.id)),
        response_metadata: { next_cursor: "" },
      });
    }
    if (method === "conversations.leave") {
      const err = leaveErrors[channel];
      if (err) return json({ ok: false, error: err });
      left.add(channel);
      return json({ ok: true });
    }
    if (method === "users.channelSections.channels.bulkUpdate") {
      return json({ ok: true });
    }
    if (method === "activity.feed") {
      return json({ ok: true, items: [] });
    }
    return json({ ok: false, error: "unknown_method" });
  };

  assert.equal(typeof pollHooks.pollOnce, "function");
  await pollHooks.pollOnce("https://example.slack.com", "T1", "xoxc-test", "U1");
  return { calls, logs, attrs, left };
}

test("cleanup leaves the planned batch via conversations.leave, then files waiting vsl- channels", async () => {
  const { calls, attrs } = await runPollOnce({});
  const leaveIds = calls.filter((c) => c.method === "conversations.leave").map((c) => c.channel);
  assert.deepEqual(fromVm(leaveIds), EXPECTED_OLDEST_100);

  const methods = calls.map((c) => c.method);
  const lastLeave = methods.lastIndexOf("conversations.leave");
  const bulk = methods.indexOf("users.channelSections.channels.bulkUpdate");
  assert.ok(bulk > lastLeave, "sort pass must run only after cleanup result is known");

  const bulkCall = calls[bulk];
  const insert = JSON.parse(bulkCall.insert);
  const inserted = insert.flatMap((row) => row.channel_ids);
  assert.ok(inserted.includes("W0001"));
  assert.ok(inserted.includes("W0002"));

  const result = JSON.parse(attrs["data-slack-autosort-last-result"]);
  assert.equal(result.kind, "cleanup");
  assert.equal(result.left, 100);
  assert.equal(result.failed, 0);
});

test("a refused leave is logged and does not substitute a later candidate", async () => {
  const { calls, logs } = await runPollOnce({
    leaveErrors: { C0001: "last_member" },
  });
  const leaveIds = calls.filter((c) => c.method === "conversations.leave").map((c) => c.channel);
  assert.deepEqual(fromVm(leaveIds), EXPECTED_OLDEST_100);
  assert.equal(leaveIds.includes("C0101"), false);

  const joined = logs.join("\n");
  assert.match(joined, /last_member/);
  assert.match(joined, /C0001|vsl-keep-1/);
  assert.match(joined, /left 99, 1 failed/i);
});

test("rate limit stops further leaves and still runs sort after the cleanup result", async () => {
  const { calls } = await runPollOnce({
    leaveErrors: { C0011: "ratelimited" },
  });
  const leaveIds = calls.filter((c) => c.method === "conversations.leave").map((c) => c.channel);
  assert.deepEqual(fromVm(leaveIds), EXPECTED_OLDEST_100.slice(0, 11));

  const methods = calls.map((c) => c.method);
  const lastLeave = methods.lastIndexOf("conversations.leave");
  const bulk = methods.indexOf("users.channelSections.channels.bulkUpdate");
  assert.ok(bulk > lastLeave);
});

test("fail-closed planner means no conversations.leave calls", async () => {
  const { calls } = await runPollOnce({
    eligibleRename: ({ channels, sections }) => {
      const vslIds = new Set(sections[0].channel_ids_page.channel_ids);
      const keep = new Set(EXPECTED_OLDEST_100.slice(0, 99));
      for (const ch of channels) {
        if (keep.has(ch.id)) continue;
        if (ch.name && ch.name.startsWith("vsl-") && !ch.is_archived && vslIds.has(ch.id)) {
          ch.name = `other-${ch.id}`;
        }
      }
    },
  });
  assert.equal(calls.filter((c) => c.method === "conversations.leave").length, 0);
});

test("cleanup toggle off never leaves channels", async () => {
  const { calls } = await runPollOnce({ cleanupEnabled: false });
  assert.equal(calls.filter((c) => c.method === "conversations.leave").length, 0);
});

test("pollOnce requests limit 1000 on users.channelSections.list", async () => {
  const { calls } = await runPollOnce({});
  const sectionCalls = calls.filter((c) => c.method === "users.channelSections.list");
  assert.ok(sectionCalls.length >= 1, "expected users.channelSections.list");
  for (const call of sectionCalls) {
    assert.equal(call.limit, "1000");
  }
});

test("truncated section IDs without limit fail closed with observable reason", async () => {
  const { hooks: pollHooks, sandbox, attrs } = loadHooks();
  const fixture = mixedVslAtLimit();
  const allChannels = fixture.channels.concat(WAITING);
  const left = new Set();
  const logs = [];
  sandbox.console = {
    log: (...a) => logs.push(a.map(String).join(" ")),
    warn: (...a) => logs.push(a.map(String).join(" ")),
  };
  attrs["data-slack-autosort-rules"] = JSON.stringify([{ prefix: "vsl-", section: "VSL" }]);
  attrs["data-slack-autosort-vsl-capacity-cleanup"] = "true";

  sandbox.fetch = async (url, opts) => {
    const method = apiMethod(url);
    const body = opts && opts.body;
    const channel = body && body.get ? body.get("channel") : null;
    const limit = body && body.get ? body.get("limit") : null;

    if (method === "users.channelSections.list") {
      const fullIds = fixture.sections[0].channel_ids_page.channel_ids.filter((id) => !left.has(id));
      const channelIds = limit === "1000" ? fullIds : fullIds.slice(0, 100);
      const sections = fixture.sections.map((s, i) => {
        if (i !== 0) return s;
        return {
          ...s,
          channel_ids_page: { channel_ids: channelIds, count: fullIds.length },
        };
      });
      return json({ ok: true, channel_sections: sections });
    }
    if (method === "users.conversations") {
      return json({
        ok: true,
        channels: allChannels.filter((ch) => !left.has(ch.id)),
        response_metadata: { next_cursor: "" },
      });
    }
    if (method === "conversations.leave") {
      left.add(channel);
      return json({ ok: true });
    }
    if (method === "users.channelSections.channels.bulkUpdate") {
      return json({ ok: true });
    }
    if (method === "activity.feed") {
      return json({ ok: true, items: [] });
    }
    return json({ ok: false, error: "unknown_method" });
  };

  await pollHooks.pollOnce("https://example.slack.com", "T1", "xoxc-test", "U1");

  assert.equal(left.size, 100, "cleanup must leave a full batch once section IDs are complete");
  const result = JSON.parse(attrs["data-slack-autosort-last-result"]);
  assert.equal(result.kind, "cleanup");
  assert.equal(result.left, 100);
  assert.equal(result.skipReason, undefined);
});

test("a concurrent second poll does not start a second leave batch", async () => {
  const { hooks: pollHooks, sandbox, attrs } = loadHooks();
  const fixture = mixedVslAtLimit();
  const allChannels = fixture.channels.concat(WAITING);
  const left = new Set();
  const calls = [];
  attrs["data-slack-autosort-rules"] = JSON.stringify([{ prefix: "vsl-", section: "VSL" }]);
  attrs["data-slack-autosort-vsl-capacity-cleanup"] = "true";

  let releaseFirstLeave;
  const firstLeaveHeld = new Promise((resolve) => {
    releaseFirstLeave = resolve;
  });
  let resolveSawFirstLeave;
  const sawFirstLeave = new Promise((resolve) => {
    resolveSawFirstLeave = resolve;
  });
  let leaveCount = 0;

  sandbox.fetch = async (url, opts) => {
    const method = apiMethod(url);
    const body = opts && opts.body;
    const channel = body && body.get ? body.get("channel") : null;
    const insert = body && body.get ? body.get("insert") : null;
    calls.push({ method, channel, insert });

    if (method === "users.channelSections.list") {
      const remaining = fixture.sections[0].channel_ids_page.channel_ids.filter((id) => !left.has(id));
      const sections = fixture.sections.map((s, i) => {
        if (i !== 0) return s;
        return {
          ...s,
          channel_ids_page: { channel_ids: remaining, count: remaining.length },
        };
      });
      return json({ ok: true, channel_sections: sections });
    }
    if (method === "users.conversations") {
      return json({
        ok: true,
        channels: allChannels.filter((ch) => !left.has(ch.id)),
        response_metadata: { next_cursor: "" },
      });
    }
    if (method === "conversations.leave") {
      leaveCount += 1;
      if (leaveCount === 1) {
        resolveSawFirstLeave();
        await firstLeaveHeld;
      }
      left.add(channel);
      return json({ ok: true });
    }
    if (method === "users.channelSections.channels.bulkUpdate") {
      return json({ ok: true });
    }
    if (method === "activity.feed") {
      return json({ ok: true, items: [] });
    }
    return json({ ok: false, error: "unknown_method" });
  };

  const poll1 = pollHooks.pollOnce("https://example.slack.com", "T1", "xoxc-test", "U1");
  await sawFirstLeave;
  const poll2 = pollHooks.pollOnce("https://example.slack.com", "T1", "xoxc-test", "U1");
  await poll2;

  const leavesWhileFirstHeld = calls
    .filter((c) => c.method === "conversations.leave")
    .map((c) => c.channel);
  assert.equal(leavesWhileFirstHeld.length, 1, "second poll must not leave while the first cleanup is held");

  releaseFirstLeave();
  await poll1;

  const leaveIds = calls.filter((c) => c.method === "conversations.leave").map((c) => c.channel);
  assert.deepEqual(fromVm(leaveIds), EXPECTED_OLDEST_100);
});
