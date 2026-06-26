/**
 * Slack Channel Auto-Sort — content script (isolated world)
 *
 * Bridges chrome.storage.sync (rules + auto-read prefixes) → DOM
 * attributes, which the MAIN-world inject.js reads. Splitting is
 * required because content scripts in the isolated world can't make
 * first-party CORS-allowed fetches to Slack's API; only the page's
 * own JS context can.
 */

(function () {
  "use strict";

  const ATTR_RULES = "data-slack-autosort-rules";
  const ATTR_AUTOREAD = "data-slack-autosort-autoread";
  const ATTR_AUTOREAD_INVITES = "data-slack-autosort-autoread-invites";
  const ATTR_AUTOREAD_BROADCASTS = "data-slack-autosort-autoread-broadcasts";

  const DEFAULT_RULES = [
    { prefix: "vsl-", section: "VSL" },
    { prefix: "systems-", section: "Systems" },
    { prefix: "funnel-", section: "Funnel Build" },
    { prefix: "internal-", section: "Internal" },
  ];

  const DEFAULT_AUTOREAD = [];
  const DEFAULT_AUTOREAD_INVITES = [];
  const DEFAULT_AUTOREAD_BROADCASTS = [];

  function publish(rules, autoRead, autoReadInvites, autoReadBroadcasts) {
    document.documentElement.setAttribute(ATTR_RULES, JSON.stringify(rules));
    document.documentElement.setAttribute(ATTR_AUTOREAD, JSON.stringify(autoRead));
    document.documentElement.setAttribute(ATTR_AUTOREAD_INVITES, JSON.stringify(autoReadInvites));
    document.documentElement.setAttribute(ATTR_AUTOREAD_BROADCASTS, JSON.stringify(autoReadBroadcasts));
  }

  function loadAll() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        {
          rules: DEFAULT_RULES,
          autoReadPrefixes: DEFAULT_AUTOREAD,
          autoReadInvitePrefixes: DEFAULT_AUTOREAD_INVITES,
          autoReadBroadcastPrefixes: DEFAULT_AUTOREAD_BROADCASTS,
        },
        (data) => resolve(data)
      );
    });
  }

  loadAll().then((data) => {
    publish(
      data.rules,
      data.autoReadPrefixes,
      data.autoReadInvitePrefixes,
      data.autoReadBroadcastPrefixes
    );
    console.log(
      `[auto-sort/bridge] Published ${data.rules.length} sort rules, ${data.autoReadPrefixes.length} full-auto-read, ${data.autoReadInvitePrefixes.length} invite-auto-read, ${data.autoReadBroadcastPrefixes.length} broadcast-auto-read.`
    );
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (
      changes.rules ||
      changes.autoReadPrefixes ||
      changes.autoReadInvitePrefixes ||
      changes.autoReadBroadcastPrefixes
    ) {
      chrome.storage.sync.get(
        {
          rules: DEFAULT_RULES,
          autoReadPrefixes: DEFAULT_AUTOREAD,
          autoReadInvitePrefixes: DEFAULT_AUTOREAD_INVITES,
          autoReadBroadcastPrefixes: DEFAULT_AUTOREAD_BROADCASTS,
        },
        (data) => {
          publish(
            data.rules,
            data.autoReadPrefixes,
            data.autoReadInvitePrefixes,
            data.autoReadBroadcastPrefixes
          );
          console.log("[auto-sort/bridge] Config updated; republished.");
        }
      );
    }
  });
})();
