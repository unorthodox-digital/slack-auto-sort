/**
 * Thread selection, against a RECORDED client.counts response.
 *
 * The shape below was recorded from a real read-only probe on 2026-08-20.
 * Channel ids are synthetic; the structure is verbatim, which is the part
 * that matters — `threads.unread_count_by_channel` and
 * `threads.mention_count_by_channel` are what the mention guard stands on.
 *
 * Run: node --test tests/
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { selectThreadChannels, THREAD_PREFIXES } = require("../thread-select.js");

const CHANNELS = [
  { id: "C_VSL", name: "vsl-acme" },
  { id: "C_FUNNEL", name: "funnel-acme" },
  { id: "C_SYSTEMS", name: "systems-acme" },
  { id: "C_OTHER", name: "feedback-custom-dashboard" },
  { id: "C_UPPER", name: "VSL-Shouty" },
];

// The recorded shape, with the counts swapped for the case under test.
function counts(unread, mentions) {
  return {
    ok: true,
    threads: {
      has_unreads: Object.keys(unread).length > 0,
      mention_count: 0,
      vip_count: 0,
      mention_count_by_channel: mentions,
      unread_count_by_channel: unread,
    },
    channels: [],
  };
}

const select = (c) => selectThreadChannels(c, CHANNELS);

test("the three approved prefixes are the whole allowlist", () => {
  assert.deepStrictEqual(THREAD_PREFIXES, ["vsl-", "funnel-", "systems-"]);
});

test("an approved channel with unread threads and no mentions is eligible", () => {
  assert.deepStrictEqual(select(counts({ C_VSL: 2 }, {})), ["C_VSL"]);
});

test("all three approved prefixes are honoured", () => {
  const got = select(counts({ C_VSL: 1, C_FUNNEL: 3, C_SYSTEMS: 9 }, {}));
  assert.deepStrictEqual(got.sort(), ["C_FUNNEL", "C_SYSTEMS", "C_VSL"]);
});

test("prefix matching ignores case", () => {
  assert.deepStrictEqual(select(counts({ C_UPPER: 1 }, {})), ["C_UPPER"]);
});

test("a channel outside the allowlist is never eligible", () => {
  // This is the real channel that held the only unread threads on the day of
  // the probe. It is not an approved prefix, so it is not touchable.
  assert.deepStrictEqual(select(counts({ C_OTHER: 2 }, {})), []);
});

test("a thread mention in the channel protects the whole channel", () => {
  assert.deepStrictEqual(select(counts({ C_VSL: 2 }, { C_VSL: 1 })), []);
});

test("a mention in one approved channel does not protect another", () => {
  const got = select(counts({ C_VSL: 2, C_FUNNEL: 1 }, { C_VSL: 1 }));
  assert.deepStrictEqual(got, ["C_FUNNEL"]);
});

test("a zero unread count is not eligible", () => {
  assert.deepStrictEqual(select(counts({ C_VSL: 0 }, {})), []);
});

test("an unnameable channel id is not eligible", () => {
  assert.deepStrictEqual(select(counts({ C_GHOST: 4 }, {})), []);
});

// ── Fail-closed cases: every unknown means leave it unread ────────────────

test("no counts at all clears nothing", () => {
  for (const bad of [null, undefined, "", 0, [], "ok"]) {
    assert.deepStrictEqual(selectThreadChannels(bad, CHANNELS), []);
  }
});

test("a missing threads block clears nothing", () => {
  assert.deepStrictEqual(select({ ok: true, channels: [] }), []);
});

test("a MISSING mention map clears nothing, even with unread threads", () => {
  // The guard cannot prove a thread does not name him, so nothing is safe.
  const c = counts({ C_VSL: 2 }, {});
  delete c.threads.mention_count_by_channel;
  assert.deepStrictEqual(select(c), []);
});

test("a malformed mention map clears nothing", () => {
  for (const bad of [null, "none", 3, ["C_VSL"]]) {
    assert.deepStrictEqual(select(counts({ C_VSL: 2 }, bad)), []);
  }
});

test("an EMPTY mention map is a real answer and does not block", () => {
  // Empty means "no thread mentions anywhere", which is what the live probe
  // actually returned. It must not be confused with a missing map.
  assert.deepStrictEqual(select(counts({ C_VSL: 2 }, {})), ["C_VSL"]);
});

test("a non-numeric mention entry clears that channel", () => {
  assert.deepStrictEqual(select(counts({ C_VSL: 2 }, { C_VSL: "1" })), []);
});

test("a non-numeric unread count is not eligible", () => {
  assert.deepStrictEqual(select(counts({ C_VSL: "2" }, {})), []);
});

test("a malformed channel list clears nothing", () => {
  assert.deepStrictEqual(selectThreadChannels(counts({ C_VSL: 2 }, {}), null), []);
});

// ── Hardening, every case from the review's live probe ────────────────────

test("a response that did not succeed proves nothing", () => {
  const c = counts({ C_VSL: 2 }, {});
  c.ok = false;
  assert.deepStrictEqual(select(c), []);
});

test("callers cannot widen the allowlist", () => {
  // A third argument used to be honoured, so [""] matched every channel.
  // The signature takes two arguments now and the list is internal.
  assert.strictEqual(selectThreadChannels.length, 2);
  assert.deepStrictEqual(selectThreadChannels(counts({ C_OTHER: 1 }, {}), CHANNELS, [""]), []);
});

test("the exported allowlist is frozen", () => {
  assert.ok(Object.isFrozen(THREAD_PREFIXES));
  assert.throws(() => { "use strict"; THREAD_PREFIXES.push("x-"); });
});

test("an INHERITED mention map is not accepted", () => {
  const threads = Object.assign(Object.create({ mention_count_by_channel: {} }), {
    unread_count_by_channel: { C_VSL: 2 },
  });
  assert.deepStrictEqual(select({ ok: true, threads }), []);
});

test("a positive mention inherited from the map's prototype still protects", () => {
  // This is the dangerous one: hasOwnProperty read it as absent, so a real
  // mention became "zero mentions" and the channel was cleared.
  const mentions = Object.assign(Object.create({ C_VSL: 1 }), {});
  assert.deepStrictEqual(select(counts({ C_VSL: 2 }, mentions)), []);
});

test("an INHERITED unread map is not accepted", () => {
  const threads = Object.assign(Object.create({ unread_count_by_channel: { C_VSL: 2 } }), {
    mention_count_by_channel: {},
  });
  assert.deepStrictEqual(select({ ok: true, threads }), []);
});

test("a NaN or negative mention count is not 'no mention'", () => {
  for (const bad of [NaN, -1, -Infinity, 1.5, Infinity]) {
    assert.deepStrictEqual(select(counts({ C_VSL: 2 }, { C_VSL: bad })), [], String(bad));
  }
});

test("a non-integer or infinite unread count is not eligible", () => {
  for (const bad of [Infinity, NaN, -3, 2.5]) {
    assert.deepStrictEqual(select(counts({ C_VSL: bad }, {})), [], String(bad));
  }
});

test("a duplicated channel id is invalidated, not last-one-wins", () => {
  const dupes = [
    { id: "C_DUP", name: "not-approved" },
    { id: "C_DUP", name: "vsl-sneaky" },
  ];
  assert.deepStrictEqual(selectThreadChannels(counts({ C_DUP: 2 }, {}), dupes), []);
});

test("an id colliding with an Object.prototype key is handled by own-keys only", () => {
  const weird = [{ id: "constructor", name: "vsl-real" }];
  // Named and unique, so it is a legitimate channel and may be cleared.
  assert.deepStrictEqual(selectThreadChannels(counts({ constructor: 2 }, {}), weird), [
    "constructor",
  ]);
  // Unnamed, so it must not resolve to an inherited function value.
  assert.deepStrictEqual(selectThreadChannels(counts({ constructor: 2 }, {}), []), []);
});

test("a __proto__ key is an ordinary key and pollutes nothing", () => {
  // JSON.parse gives this an OWN "__proto__" property. Because both maps are
  // copied onto null-prototype objects, it behaves as a plain string key
  // rather than reaching Object.prototype.
  const polluted = JSON.parse('{"__proto__": 2}');
  const got = selectThreadChannels(counts(polluted, {}), [
    { id: "__proto__", name: "vsl-x" },
  ]);

  assert.deepStrictEqual(got, ["__proto__"]);
  assert.strictEqual({}.vsl, undefined, "Object.prototype must be untouched");
  assert.strictEqual(Object.prototype.__proto__, Object.getPrototypeOf(Object.prototype));
});

test("a hand-built map with a custom prototype is refused", () => {
  // Its inherited entries would be invisible to an own-property read, which
  // is exactly how a real mention could be read as zero.
  const mentions = Object.assign(Object.create({ C_VSL: 1 }), {});
  assert.deepStrictEqual(select(counts({ C_VSL: 2 }, mentions)), []);
  const unread = Object.assign(Object.create({ C_VSL: 2 }), {});
  assert.deepStrictEqual(select(counts(unread, {})), []);
});

test("a non-enumerable positive mention still protects the channel", () => {
  // Object.keys could not see it, so a real mention read as zero.
  const mentions = {};
  Object.defineProperty(mentions, "C_VSL", { value: 1, enumerable: false });
  assert.deepStrictEqual(select(counts({ C_VSL: 2 }, mentions)), []);
});

test("a getter that throws in a count map fails closed", () => {
  const mentions = {};
  Object.defineProperty(mentions, "C_VSL", {
    get() { throw new Error("boom"); },
    enumerable: true,
  });
  assert.deepStrictEqual(select(counts({ C_VSL: 2 }, mentions)), []);
});

test("a stateful channel-id getter cannot dodge duplicate invalidation", () => {
  // Reading ch.id twice used to yield two different ids, so the duplicate
  // check never saw a duplicate.
  let reads = 0;
  const sneaky = {
    get id() { reads += 1; return reads === 1 ? "C_DUP" : "C_OTHERID"; },
    name: "vsl-sneaky",
  };
  const got = selectThreadChannels(counts({ C_DUP: 2 }, {}), [sneaky, { id: "C_DUP", name: "nope" }]);
  assert.deepStrictEqual(got, []);
});

test("a channel entry whose getter throws is skipped, not fatal", () => {
  const bad = { get id() { throw new Error("boom"); } };
  assert.deepStrictEqual(
    selectThreadChannels(counts({ C_VSL: 2 }, {}), [bad, { id: "C_VSL", name: "vsl-ok" }]),
    ["C_VSL"]
  );
});
