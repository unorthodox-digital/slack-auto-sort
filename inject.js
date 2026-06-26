/**
 * Slack Channel Auto-Sort — page-injected script (MAIN world)
 *
 * Runs in the same JS context as Slack's own client, so fetch() to
 * the workspace API succeeds with first-party CORS + cookie auth.
 *
 * Reads rules + auto-read prefixes from DOM attributes set by
 * content.js (isolated world). Reads token + workspace URL from
 * localStorage.localConfig_v2.
 */

(function () {
  "use strict";

  // Build marker — confirm which build is actually live on the page via console:
  //   document.documentElement.getAttribute("data-slack-autosort-version")
  document.documentElement.setAttribute("data-slack-autosort-version", "1.3.4");

  const ATTR_RULES = "data-slack-autosort-rules";
  const ATTR_AUTOREAD = "data-slack-autosort-autoread";
  const ATTR_AUTOREAD_INVITES = "data-slack-autosort-autoread-invites";
  const ATTR_AUTOREAD_BROADCASTS = "data-slack-autosort-autoread-broadcasts";
  const POLL_INTERVAL_MS = 60000;
  const BOOT_DELAY_MS = 5000;
  const INVITE_HISTORY_LIMIT = 30;
  const BROADCAST_HISTORY_LIMIT = 50;
  const JOIN_SUBTYPES = new Set(["channel_join", "group_join"]);
  const BROADCAST_TEXT_RE = /<!channel>|<!here>|<!everyone>/;

  // Rate-limit guards — Slack's conversations.history is tier 3 (~50/min).
  // Each pass fetches at most this many channels per poll cycle; channels
  // already fetched within the cooldown window are skipped.
  const HISTORY_MAX_PER_POLL = 10;
  const BROADCAST_REFETCH_COOLDOWN_MS = 5 * 60 * 1000;

  // Per-session cache: channel IDs whose invitation has already been cleared.
  // Avoids re-fetching history every poll for the same channel. Re-cleared on
  // page reload — fine, since the worst case is one extra mark.
  const invitationsCleared = new Set();
  // Per-session cache: channel ID → ts last marked by the broadcast pass.
  // Avoids redundant marks when no new broadcast has arrived.
  const broadcastsLastMarked = new Map();
  // Per-session cache: channel ID → epoch ms of last history fetch attempt.
  // Throttles re-fetching the same channel.
  const broadcastsLastFetched = new Map();

  function isRateLimitError(e) {
    return e && /ratelimited/i.test(e.message || "");
  }

  function getRules() {
    const raw = document.documentElement.getAttribute(ATTR_RULES);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch (e) {
      return [];
    }
  }

  function getAutoReadPrefixes() {
    const raw = document.documentElement.getAttribute(ATTR_AUTOREAD);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map((p) => String(p).toLowerCase()).filter(Boolean) : [];
    } catch (e) {
      return [];
    }
  }

  function getAutoReadInvitePrefixes() {
    const raw = document.documentElement.getAttribute(ATTR_AUTOREAD_INVITES);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map((p) => String(p).toLowerCase()).filter(Boolean) : [];
    } catch (e) {
      return [];
    }
  }

  function getAutoReadBroadcastPrefixes() {
    const raw = document.documentElement.getAttribute(ATTR_AUTOREAD_BROADCASTS);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map((p) => String(p).toLowerCase()).filter(Boolean) : [];
    } catch (e) {
      return [];
    }
  }

  function getActiveTeam() {
    try {
      const raw = localStorage.getItem("localConfig_v2");
      if (!raw) return null;
      const config = JSON.parse(raw);
      if (!config || !config.teams) return null;

      const match = window.location.pathname.match(/\/client\/(T[A-Z0-9]+)/);
      if (match && config.teams[match[1]]) {
        const t = config.teams[match[1]];
        return { ...t, _id: match[1] };
      }
      const id = Object.keys(config.teams).find((k) => config.teams[k] && config.teams[k].token);
      return id ? { ...config.teams[id], _id: id } : null;
    } catch (e) {
      return null;
    }
  }

  function makeApiUrl(apiBase, method, teamId) {
    const url = new URL(`${apiBase}/api/${method}`);
    // Match Slack's internal client query params — server appears to return
    // strict-origin CORS only when these "official client" markers are present.
    const rand = Math.random().toString(36).slice(2, 10);
    url.searchParams.set("_x_id", `${rand}-${Date.now() / 1000}`);
    url.searchParams.set("_x_csid", "autosort");
    if (teamId) url.searchParams.set("slack_route", teamId);
    url.searchParams.set("_x_version_ts", "noversion");
    url.searchParams.set("_x_frontend_build_type", "current");
    url.searchParams.set("_x_desktop_ia", "4");
    url.searchParams.set("_x_gantry", "true");
    url.searchParams.set("fp", "e1");
    url.searchParams.set("_x_num_retries", "0");
    return url.toString();
  }

  function teamApiBase(team) {
    if (team && team.url) return team.url.replace(/\/$/, "");
    if (team && team.domain) return `https://${team.domain}.slack.com`;
    return null;
  }

  function matchRule(rules, channelName) {
    const name = channelName.toLowerCase();
    return rules.find((r) => name.startsWith(r.prefix.toLowerCase()));
  }

  function matchesAutoRead(prefixes, channelName) {
    const name = channelName.toLowerCase();
    return prefixes.some((p) => name.startsWith(p));
  }

  async function slackApi(apiBase, teamId, token, method, params) {
    const formData = new FormData();
    formData.append("token", token);
    for (const [k, v] of Object.entries(params)) {
      formData.append(k, v);
    }
    const resp = await fetch(makeApiUrl(apiBase, method, teamId), {
      method: "POST",
      body: formData,
      credentials: "include",
    });
    const result = await resp.json();
    if (!result.ok) throw new Error(`${method}: ${result.error}`);
    return result;
  }

  function getSectionChannelMap(sections) {
    const map = {};
    for (const s of sections) {
      const ids = (s.channel_ids_page && s.channel_ids_page.channel_ids) || [];
      for (const cid of ids) map[cid] = s.channel_section_id;
    }
    return map;
  }

  // Fetch the FULL channel list, paging through Slack's cursor pagination.
  // users.conversations caps each page (~1000); a single fixed-limit call
  // silently truncated the list once the workspace grew past that, so the
  // newest channels never got seen or sorted. Loop until next_cursor is
  // empty, with a safety cap so a misbehaving cursor can't spin forever.
  async function fetchAllConversations(apiBase, teamId, token) {
    let channels = [];
    let cursor = "";
    let page = 0;
    do {
      const params = {
        types: "public_channel,private_channel",
        limit: "1000",
        // Include archived channels so the broadcast pass can clear archive
        // notifications (channel_archive system messages) from the Activity
        // feed. sortPass filters them out — see below.
        exclude_archived: "false",
      };
      if (cursor) params.cursor = cursor;
      const resp = await slackApi(apiBase, teamId, token, "users.conversations", params);
      channels = channels.concat(resp.channels || []);
      cursor = (resp.response_metadata && resp.response_metadata.next_cursor) || "";
      page++;
    } while (cursor && page < 20); // 20 × 1000 = 20k channels — far past any real workspace
    return channels;
  }

  async function fetchState(apiBase, teamId, token) {
    const [secResp, channels] = await Promise.all([
      slackApi(apiBase, teamId, token, "users.channelSections.list", {}),
      fetchAllConversations(apiBase, teamId, token),
    ]);
    return {
      sections: secResp.channel_sections || [],
      channels,
    };
  }

  async function sortPass(apiBase, teamId, token, sections, channels) {
    const rules = getRules();
    if (!rules.length) return;

    const sectionByName = {};
    for (const s of sections) {
      if (s.name) sectionByName[s.name.toLowerCase()] = s.channel_section_id;
    }
    const channelToSection = getSectionChannelMap(sections);

    const moves = {};
    for (const ch of channels) {
      if (ch.is_archived) continue; // never move archived channels into sections
      const rule = matchRule(rules, ch.name);
      if (!rule) continue;
      const targetId = sectionByName[rule.section.toLowerCase()];
      if (!targetId) {
        console.warn(`[auto-sort] Section "${rule.section}" not found — skipping #${ch.name}`);
        continue;
      }
      if (channelToSection[ch.id] === targetId) continue;
      (moves[targetId] = moves[targetId] || []).push({
        id: ch.id,
        name: ch.name,
        target: rule.section,
      });
    }

    const flat = Object.values(moves).flat();
    if (!flat.length) return;

    const insert = Object.entries(moves).map(([sid, items]) => ({
      channel_section_id: sid,
      channel_ids: items.map((i) => i.id),
    }));

    try {
      await slackApi(apiBase, teamId, token, "users.channelSections.channels.bulkUpdate", {
        insert: JSON.stringify(insert),
        remove: JSON.stringify([]),
        _x_reason: "channel-sidebar-channel-drop",
        _x_mode: "online",
        _x_sonic: "true",
        _x_app_name: "client",
      });
      for (const m of flat) {
        console.log(`[auto-sort] Moved #${m.name} → ${m.target}`);
      }
    } catch (e) {
      console.warn("[auto-sort] bulkUpdate failed:", e.message);
    }
  }

  async function markChannelRead(apiBase, teamId, token, channel) {
    // Try the cheap path first: send "now" as the read marker. Slack's internal
    // client API generally accepts this. If the server objects to the ts, fall
    // back to fetching the channel's latest message and using its ts.
    const nowTs = (Date.now() / 1000).toFixed(6);
    try {
      await slackApi(apiBase, teamId, token, "conversations.mark", {
        channel: channel.id,
        ts: nowTs,
      });
      return true;
    } catch (e) {
      const msg = e.message || "";
      if (/ratelimited/i.test(msg)) throw e; // let the pass back off instead of hammering
      if (!/invalid_ts|invalid_arguments|not_in_channel/i.test(msg)) {
        console.warn(`[auto-read] mark failed for #${channel.name}:`, msg);
        return false;
      }
      try {
        const hist = await slackApi(apiBase, teamId, token, "conversations.history", {
          channel: channel.id,
          limit: "1",
        });
        const latest = hist.messages && hist.messages[0];
        if (!latest) return true; // empty channel — nothing to mark
        await slackApi(apiBase, teamId, token, "conversations.mark", {
          channel: channel.id,
          ts: latest.ts,
        });
        return true;
      } catch (e2) {
        if (/ratelimited/i.test(e2.message || "")) throw e2;
        console.warn(`[auto-read] fallback mark failed for #${channel.name}:`, e2.message);
        return false;
      }
    }
  }

  // One call returns every channel's unread state — the same source Slack's own
  // client uses for badge counts. Lets the auto-read pass touch only channels
  // that actually need marking, instead of blasting conversations.mark at every
  // matching channel each poll (which instantly rate-limits the whole pass).
  // Returns a Set of unread channel IDs, or null if the call failed (caller
  // falls back to a capped sweep).
  async function fetchUnreadChannelIds(apiBase, teamId, token) {
    try {
      const r = await slackApi(apiBase, teamId, token, "client.counts", {});
      const ids = new Set();
      for (const c of r.channels || []) {
        if (c.has_unreads || (c.mention_count || 0) > 0) ids.add(c.id);
      }
      return ids;
    } catch (e) {
      return null;
    }
  }

  async function autoReadPass(apiBase, teamId, token, channels) {
    const prefixes = getAutoReadPrefixes();
    if (!prefixes.length) return;

    let matches = channels.filter(
      (ch) => ch.name && matchesAutoRead(prefixes, ch.name)
    );
    if (!matches.length) return;

    // Narrow to channels that are ACTUALLY unread. Without this the pass marks
    // every matching channel every poll and 429s itself into doing nothing.
    const unread = await fetchUnreadChannelIds(apiBase, teamId, token);
    const usedCounts = unread !== null;
    if (usedCounts) matches = matches.filter((ch) => unread.has(ch.id));

    console.log(
      `[auto-read] ${matches.length} channel(s) to mark ` +
        `(unread source: ${usedCounts ? "client.counts" : "unavailable — capped sweep"}).`
    );
    if (!matches.length) return;

    let cleared = 0;
    let processed = 0;
    let rateLimited = false;
    for (const ch of matches) {
      if (processed >= HISTORY_MAX_PER_POLL) break; // cap marks per poll
      processed++;
      try {
        if (await markChannelRead(apiBase, teamId, token, ch)) cleared++;
      } catch (e) {
        if (isRateLimitError(e)) {
          rateLimited = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 250)); // pace under the tier limit
    }
    if (rateLimited) {
      console.warn("[auto-read] Rate limited; backing off until next poll.");
    }
    if (cleared) {
      console.log(`[auto-read] Cleared ${cleared} channel${cleared === 1 ? "" : "s"}.`);
    }
  }

  async function findOwnJoinTs(apiBase, teamId, token, channelId, myUserId) {
    const hist = await slackApi(apiBase, teamId, token, "conversations.history", {
      channel: channelId,
      limit: String(INVITE_HISTORY_LIMIT),
    });
    const messages = hist.messages || [];
    // Slack returns messages newest-first. Iterate in arrival order (oldest →
    // newest) so we pick the EARLIEST own-join in the window — that's the
    // invitation system message; later messages are real content the user
    // cares about.
    const oldestFirst = messages.slice().reverse();
    for (const m of oldestFirst) {
      if (
        JOIN_SUBTYPES.has(m.subtype) &&
        m.user === myUserId
      ) {
        return m.ts;
      }
    }
    return null;
  }

  function isUserMention(m, myUserId) {
    if (!myUserId || !m || !m.text) return false;
    return m.text.includes(`<@${myUserId}>`);
  }

  function isBroadcast(m, myUserId) {
    if (!m) return false;
    // System events: channel_join, channel_leave, channel_archive, channel_topic,
    // channel_purpose, channel_name, group_join, group_leave, etc.
    if (m.subtype && (m.subtype.startsWith("channel_") || m.subtype.startsWith("group_"))) {
      return true;
    }
    // Bot messages.
    if (m.bot_id || m.subtype === "bot_message") {
      // If the bot ALSO directly mentions the user, treat as user-mention (not broadcast).
      if (isUserMention(m, myUserId)) return false;
      return true;
    }
    // @channel / @here / @everyone broadcasts in regular human messages.
    if (m.text && BROADCAST_TEXT_RE.test(m.text)) {
      // If the same message ALSO directly @-mentions the user, preserve it.
      if (isUserMention(m, myUserId)) return false;
      return true;
    }
    return false;
  }

  async function findReadableBroadcastTs(apiBase, teamId, token, channelId, myUserId) {
    const hist = await slackApi(apiBase, teamId, token, "conversations.history", {
      channel: channelId,
      limit: String(BROADCAST_HISTORY_LIMIT),
    });
    const messages = hist.messages || [];

    // Pass 1: floor = oldest direct @-user mention's ts in window. Anything at
    // or above this floor must NOT be marked, to preserve the unread mention.
    let floor = Infinity;
    for (const m of messages) {
      if (isUserMention(m, myUserId)) {
        const ts = parseFloat(m.ts);
        if (ts < floor) floor = ts;
      }
    }

    // Pass 2: highest broadcast ts strictly below the floor.
    let target = null;
    let targetNum = -Infinity;
    for (const m of messages) {
      if (!isBroadcast(m, myUserId)) continue;
      const ts = parseFloat(m.ts);
      if (ts < floor && ts > targetNum) {
        target = m.ts;
        targetNum = ts;
      }
    }
    return target;
  }

  async function autoReadBroadcastsPass(apiBase, teamId, token, channels, myUserId) {
    const prefixes = getAutoReadBroadcastPrefixes();
    if (!prefixes.length) return;

    const matches = channels.filter(
      (ch) => ch.name && matchesAutoRead(prefixes, ch.name)
    );
    if (!matches.length) return;

    const now = Date.now();
    let processed = 0;
    let cleared = 0;
    let rateLimitedChannelName = null;

    for (const ch of matches) {
      if (processed >= HISTORY_MAX_PER_POLL) break;
      const lastFetched = broadcastsLastFetched.get(ch.id) || 0;
      if (now - lastFetched < BROADCAST_REFETCH_COOLDOWN_MS) continue;

      // Reserve the cooldown slot BEFORE fetching, so a thrown rate-limit
      // error can roll it back without leaking cooldown to siblings.
      broadcastsLastFetched.set(ch.id, now);
      processed++;

      try {
        const targetTs = await findReadableBroadcastTs(apiBase, teamId, token, ch.id, myUserId);
        if (!targetTs) continue;
        if (broadcastsLastMarked.get(ch.id) === targetTs) continue; // no new broadcast
        await slackApi(apiBase, teamId, token, "conversations.mark", {
          channel: ch.id,
          ts: targetTs,
        });
        broadcastsLastMarked.set(ch.id, targetTs);
        cleared++;
      } catch (e) {
        if (isRateLimitError(e)) {
          // Roll back this channel's cooldown so it retries next poll, then bail.
          broadcastsLastFetched.delete(ch.id);
          rateLimitedChannelName = ch.name;
          break;
        }
        console.warn(`[auto-read-broadcast] failed for #${ch.name}:`, e.message);
      }
    }

    if (rateLimitedChannelName) {
      console.warn(
        `[auto-read-broadcast] Rate limited at #${rateLimitedChannelName}; pausing until next poll.`
      );
    }
    if (cleared) {
      console.log(`[auto-read-broadcast] Cleared broadcasts in ${cleared} channel${cleared === 1 ? "" : "s"}.`);
    }
  }

  async function autoReadInvitesPass(apiBase, teamId, token, channels, myUserId) {
    const prefixes = getAutoReadInvitePrefixes();
    if (!prefixes.length || !myUserId) return;

    const matches = channels.filter(
      (ch) =>
        ch.name &&
        !invitationsCleared.has(ch.id) &&
        matchesAutoRead(prefixes, ch.name)
    );
    if (!matches.length) return;

    let processed = 0;
    let cleared = 0;
    let rateLimitedChannelName = null;

    for (const ch of matches) {
      if (processed >= HISTORY_MAX_PER_POLL) break;
      processed++;
      try {
        const joinTs = await findOwnJoinTs(apiBase, teamId, token, ch.id, myUserId);
        if (!joinTs) {
          // No invitation visible (likely already past its history window) —
          // mark as handled so we don't re-fetch every poll.
          invitationsCleared.add(ch.id);
          continue;
        }
        await slackApi(apiBase, teamId, token, "conversations.mark", {
          channel: ch.id,
          ts: joinTs,
        });
        invitationsCleared.add(ch.id);
        cleared++;
      } catch (e) {
        if (isRateLimitError(e)) {
          // Don't add to cleared set; will retry on next poll.
          rateLimitedChannelName = ch.name;
          break;
        }
        console.warn(`[auto-read-invite] failed for #${ch.name}:`, e.message);
      }
    }

    if (rateLimitedChannelName) {
      console.warn(
        `[auto-read-invite] Rate limited at #${rateLimitedChannelName}; pausing until next poll.`
      );
    }
    if (cleared) {
      console.log(`[auto-read-invite] Cleared invitations for ${cleared} channel${cleared === 1 ? "" : "s"}.`);
    }
  }

  // Clears "X archived the channel Y" notices from the Activity feed. They
  // arrive as generic_system_alert items (category CHANNEL) and pile up after a
  // bulk-archive — channel-level mark-read can't touch them, they have a
  // separate read-state. activity.feed lists them; activity.archive dismisses
  // each. (Reverse-engineered from the Slack web client's own calls.)
  async function clearArchiveNoticesPass(apiBase, teamId, token) {
    let resp;
    try {
      resp = await slackApi(apiBase, teamId, token, "activity.feed", {
        mode: "chrono_v1",
        types: "generic_system_alert",
        limit: "50",
        unread_only: "true",
        archive_only: "false",
        is_activity_inbox: "true",
        _x_reason: "fetchActivityFeed",
        _x_mode: "online",
        _x_sonic: "true",
        _x_app_name: "client",
      });
    } catch (e) {
      console.warn("[auto-clear] activity.feed failed:", e.message);
      return;
    }
    const items = (resp.items || []).filter((it) => {
      const p = it.item && it.item.generic_system_alert_payload;
      return p && p.category === "CHANNEL";
    });
    if (!items.length) return;

    let cleared = 0;
    let processed = 0;
    let rateLimited = false;
    for (const it of items) {
      if (processed >= HISTORY_MAX_PER_POLL) break; // cap per poll
      processed++;
      try {
        await slackApi(apiBase, teamId, token, "activity.archive", {
          type: it.item.type,
          key: it.key,
          ts: it.feed_ts,
          _x_reason: "clear_notification_button",
          _x_mode: "online",
          _x_sonic: "true",
          _x_app_name: "client",
        });
        cleared++;
      } catch (e) {
        if (isRateLimitError(e)) {
          rateLimited = true;
          break;
        }
        console.warn(`[auto-clear] archive failed for ${it.key}:`, e.message);
      }
      await new Promise((r) => setTimeout(r, 150)); // pace under the tier limit
    }
    if (rateLimited) {
      console.warn("[auto-clear] Rate limited; backing off until next poll.");
    }
    if (cleared) {
      console.log(
        `[auto-clear] Cleared ${cleared} "archived the channel" notice${cleared === 1 ? "" : "s"} from the Activity feed.`
      );
    }
  }

  async function pollOnce(apiBase, teamId, token, myUserId) {
    let state;
    try {
      state = await fetchState(apiBase, teamId, token);
    } catch (e) {
      console.warn("[auto-sort] API fetch failed:", e.message);
      return;
    }
    await sortPass(apiBase, teamId, token, state.sections, state.channels);
    await autoReadPass(apiBase, teamId, token, state.channels);
    await autoReadInvitesPass(apiBase, teamId, token, state.channels, myUserId);
    await autoReadBroadcastsPass(apiBase, teamId, token, state.channels, myUserId);
    await clearArchiveNoticesPass(apiBase, teamId, token);
  }

  async function resolveUserId(apiBase, teamId, token, team) {
    if (team && team.user_id) return team.user_id;
    try {
      const r = await slackApi(apiBase, teamId, token, "auth.test", {});
      return r.user_id || null;
    } catch (e) {
      console.warn("[auto-sort] auth.test failed; invitation-only auto-read disabled:", e.message);
      return null;
    }
  }

  async function init() {
    await new Promise((r) => setTimeout(r, BOOT_DELAY_MS));

    const team = getActiveTeam();
    const token = team && team.token;
    const teamId = team && team._id;
    const apiBase = teamApiBase(team);
    if (!token || !apiBase) {
      console.warn("[auto-sort] No token / workspace URL — idle.");
      return;
    }

    const myUserId = await resolveUserId(apiBase, teamId, token, team);

    console.log(`[auto-sort] API base: ${apiBase} (team ${teamId}, user ${myUserId || "?"}). Polling every ${POLL_INTERVAL_MS / 1000}s.`);

    // Watch for rule / auto-read updates from the bridge.
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (
          m.type === "attributes" &&
          (m.attributeName === ATTR_RULES ||
            m.attributeName === ATTR_AUTOREAD ||
            m.attributeName === ATTR_AUTOREAD_INVITES ||
            m.attributeName === ATTR_AUTOREAD_BROADCASTS)
        ) {
          console.log("[auto-sort] Config updated; re-running.");
          // Reset session caches so newly-added prefixes get scanned.
          if (m.attributeName === ATTR_AUTOREAD_INVITES) invitationsCleared.clear();
          if (m.attributeName === ATTR_AUTOREAD_BROADCASTS) broadcastsLastMarked.clear();
          pollOnce(apiBase, teamId, token, myUserId);
          break;
        }
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        ATTR_RULES,
        ATTR_AUTOREAD,
        ATTR_AUTOREAD_INVITES,
        ATTR_AUTOREAD_BROADCASTS,
      ],
    });

    // Re-run the instant the user refocuses the Slack tab. setInterval gets
    // heavily throttled (or frozen) while a tab is backgrounded, so a tab left
    // in the background stops sorting; this guarantees a catch-up pass the
    // moment you look at Slack again. Debounced to at most once per 10s.
    let lastFocusPoll = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastFocusPoll < 10000) return;
      lastFocusPoll = now;
      console.log("[auto-sort] Tab refocused; running catch-up pass.");
      pollOnce(apiBase, teamId, token, myUserId);
    });

    await pollOnce(apiBase, teamId, token, myUserId);
    setInterval(() => pollOnce(apiBase, teamId, token, myUserId), POLL_INTERVAL_MS);
  }

  init();
})();
