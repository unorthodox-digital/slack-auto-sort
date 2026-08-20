/**
 * Which channels' unread THREAD replies may be cleared.
 *
 * Split out of inject.js on purpose: this is the whole blast radius of the
 * thread auto-read feature, it is pure, and it is the part that has to be
 * testable off a recorded API response rather than against live Slack.
 *
 * Mher approved clearing unread thread replies in the vsl-, funnel- and
 * systems- channels, with one exception that is not negotiable: a reply that
 * names him directly stays unread.
 *
 * Every unknown fails CLOSED. Clearing an unread cannot be undone from here,
 * so anything this file cannot positively prove safe is left alone.
 *
 * Hardening notes, all from review findings against live probes:
 *
 *  - The allowlist is internal and frozen, and callers CANNOT pass one in.
 *    This module is published into Slack's own MAIN world, so an exported
 *    prefix list would be page-mutable, and a caller-supplied [""] matched
 *    every channel.
 *  - Both count maps are copied into null-prototype snapshots of their own
 *    property names, enumerable or not. Reading them directly let an
 *    inherited map be accepted
 *    and, worse, let a positive mention inherited from a prototype read as
 *    absent — that is a missed mention, the one thing this must never do.
 *  - Counts must be finite non-negative integers, and a channel proceeds
 *    only on a mention count of exactly 0. NaN and -1 both fail `> 0`, so a
 *    plain "> 0" test called them "no mention".
 *  - A channel id appearing twice is invalidated rather than letting the
 *    last name win, and each field is read once so a stateful getter cannot
 *    return a different id per read.
 *
 * LIMIT, stated plainly: this file runs in Slack's own MAIN world, so it
 * cannot defend against a hostile script in that same world — such a script
 * could define this global before us, or hand us a Proxy. What protects the
 * user today is that the write is switched off; before it is switched on,
 * this selection should move to the extension's ISOLATED world, where page
 * scripts cannot reach it. See the TODO in inject.js.
 */
(function (root) {
  "use strict";

  // Hardcoded and frozen. Adding a prefix is a code change and a review,
  // never a config edit and never a page script.
  var ALLOWED = Object.freeze(["vsl-", "funnel-", "systems-"]);

  var hasOwn = function (obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  };

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  // A finite, non-negative integer. Rejects NaN, Infinity, -1 and 1.5, each
  // of which slipped past a bare `> 0` comparison.
  function isCount(value) {
    return (
      typeof value === "number" &&
      isFinite(value) &&
      Math.floor(value) === value &&
      value >= 0
    );
  }

  // Own properties only, on a null prototype. Anything inherited disappears,
  // so a crafted or polluted prototype can neither smuggle a value in nor
  // hide one.
  function ownSnapshot(value) {
    if (!isPlainObject(value)) return null;
    // A map parsed from JSON has Object.prototype (or null, for the
    // `__proto__` key case). Anything else was built by hand, and its
    // inherited entries would be invisible to an own-property read — which
    // is how a real mention could be read as zero. Refuse it outright.
    var proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    // getOwnPropertyNames, not keys: a non-enumerable positive mention would
    // be invisible to Object.keys and read as zero. A getter that throws
    // means the map cannot be read at all, which fails closed.
    var out = Object.create(null);
    try {
      var keys = Object.getOwnPropertyNames(value);
      for (var i = 0; i < keys.length; i++) {
        out[keys[i]] = value[keys[i]];
      }
    } catch (e) {
      return null;
    }
    return out;
  }

  // id -> name, but only for ids that appear exactly once. A repeated id is
  // ambiguous, and ambiguity is not something to resolve by ordering.
  function uniqueNamesById(channels) {
    var list = Array.isArray(channels) ? channels : [];
    var seen = Object.create(null);
    var names = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      if (!isPlainObject(ch)) continue;
      // Read each field exactly once. A stateful getter that returns a
      // different id on each access walked straight past the duplicate
      // check below.
      var id, name;
      try {
        id = ch.id;
        name = ch.name;
      } catch (e) {
        continue;
      }
      if (typeof id !== "string" || !id) continue;
      seen[id] = (seen[id] || 0) + 1;
      names[id] = typeof name === "string" ? name : null;
    }
    var out = Object.create(null);
    var ids = Object.keys(names);
    for (var j = 0; j < ids.length; j++) {
      if (seen[ids[j]] === 1 && names[ids[j]]) out[ids[j]] = names[ids[j]];
    }
    return out;
  }

  function isApproved(name) {
    var lower = String(name).toLowerCase();
    for (var i = 0; i < ALLOWED.length; i++) {
      if (lower.indexOf(ALLOWED[i]) === 0) return true;
    }
    return false;
  }

  /**
   * @param counts   a client.counts response (thread_counts_by_channel=true)
   * @param channels the channel list, for id -> name
   * @returns array of channel ids whose unread threads may be cleared
   */
  function selectThreadChannels(counts, channels) {
    if (!isPlainObject(counts)) return [];
    // A response that did not succeed proves nothing about what is safe.
    if (counts.ok !== true) return [];
    if (!hasOwn(counts, "threads")) return [];

    var threads = counts.threads;
    if (!isPlainObject(threads)) return [];
    if (!hasOwn(threads, "unread_count_by_channel")) return [];
    // The mention map is the guard. A MISSING map means we cannot prove a
    // thread does not name him, so nothing is eligible. An EMPTY map is a
    // real answer — "no thread mentions anywhere" — and is what the live
    // probe returned while threads were unread.
    if (!hasOwn(threads, "mention_count_by_channel")) return [];

    var unread = ownSnapshot(threads.unread_count_by_channel);
    var mentions = ownSnapshot(threads.mention_count_by_channel);
    if (!unread || !mentions) return [];

    var nameById = uniqueNamesById(channels);

    var eligible = [];
    var ids = Object.keys(unread);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];

      var count = unread[id];
      if (!isCount(count) || count === 0) continue;

      var name = nameById[id];
      if (typeof name !== "string" || !name) continue;
      if (!isApproved(name)) continue;

      // client.counts reports thread mentions per CHANNEL, not per thread,
      // so a channel with any mention is skipped whole. That over-skips — a
      // mention in one thread protects its siblings — and over-skipping is
      // the direction this is allowed to be wrong in.
      // `mentioned !== 0` is the load-bearing check — deleting it lets a
      // real mention of 1 straight through. isCount is the type guard in
      // front of it, catching NaN and -1, which a bare comparison reads as
      // "no mention". They overlap on those two values only; neither is
      // redundant.
      var mentioned = hasOwn(mentions, id) ? mentions[id] : 0;
      if (!isCount(mentioned)) continue;
      if (mentioned !== 0) continue;

      eligible.push(id);
    }
    return eligible;
  }

  var api = Object.freeze({
    THREAD_PREFIXES: ALLOWED,
    selectThreadChannels: selectThreadChannels,
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;          // node, for the tests
  }
  if (root) {
    // Non-writable and non-configurable, so a page script cannot swap the
    // selector out for a permissive one after this file loads.
    try {
      Object.defineProperty(root, "SlackAutoSortThreadSelect", {
        value: api,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch (e) {
      /* already defined by an earlier load: leave the first one in place */
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
