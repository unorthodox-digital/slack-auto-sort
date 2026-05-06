/**
 * Slack Channel Auto-Sort — page-injected script (MAIN world)
 *
 * Runs in the same JS context as Slack's own client, so fetch() to
 * the workspace API succeeds with first-party CORS + cookie auth.
 *
 * Reads rules from a DOM attribute set by content.js (isolated world).
 * Reads token + workspace URL from localStorage.localConfig_v2.
 */

(function () {
  "use strict";

  const ATTR = "data-slack-autosort-rules";
  const POLL_INTERVAL_MS = 60000;
  const BOOT_DELAY_MS = 5000;

  function getRules() {
    const raw = document.documentElement.getAttribute(ATTR);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
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

  async function scan(apiBase, teamId, token) {
    const rules = getRules();
    if (!rules.length) return;

    let sections, channels;
    try {
      const [secResp, chResp] = await Promise.all([
        slackApi(apiBase, teamId, token, "users.channelSections.list", {}),
        slackApi(apiBase, teamId, token, "users.conversations", {
          types: "public_channel,private_channel",
          limit: "500",
          exclude_archived: "true",
        }),
      ]);
      sections = secResp.channel_sections || [];
      channels = chResp.channels || [];
    } catch (e) {
      console.warn("[auto-sort] API fetch failed:", e.message);
      return;
    }

    const sectionByName = {};
    for (const s of sections) {
      if (s.name) sectionByName[s.name.toLowerCase()] = s.channel_section_id;
    }
    const channelToSection = getSectionChannelMap(sections);

    const moves = {}; // section_id -> [{id, name, target}]
    for (const ch of channels) {
      const rule = matchRule(rules, ch.name);
      if (!rule) continue;
      const targetId = sectionByName[rule.section.toLowerCase()];
      if (!targetId) {
        console.warn(
          `[auto-sort] Section "${rule.section}" not found — skipping #${ch.name}`
        );
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

    console.log(`[auto-sort] API base: ${apiBase} (team ${teamId}). Polling every ${POLL_INTERVAL_MS / 1000}s.`);

    // Watch for rule updates from the bridge.
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === ATTR) {
          console.log("[auto-sort] Rules updated; rescanning.");
          scan(apiBase, teamId, token);
          break;
        }
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [ATTR] });

    await scan(apiBase, teamId, token);
    setInterval(() => scan(apiBase, teamId, token), POLL_INTERVAL_MS);
  }

  init();
})();
