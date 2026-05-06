/**
 * Slack Channel Auto-Sort — content script (isolated world)
 *
 * Bridges chrome.storage.sync (rules) → DOM attribute, which the
 * MAIN-world inject.js reads. Splitting is required because content
 * scripts in the isolated world can't make first-party CORS-allowed
 * fetches to Slack's API; only the page's own JS context can.
 */

(function () {
  "use strict";

  const ATTR = "data-slack-autosort-rules";

  const DEFAULT_RULES = [
    { prefix: "vsl-", section: "VSL" },
    { prefix: "systems-", section: "Systems" },
    { prefix: "funnel-", section: "Funnel Build" },
    { prefix: "internal-", section: "Internal" },
  ];

  function publishRules(rules) {
    document.documentElement.setAttribute(ATTR, JSON.stringify(rules));
  }

  function loadRules() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ rules: DEFAULT_RULES }, (data) => resolve(data.rules));
    });
  }

  loadRules().then((rules) => {
    publishRules(rules);
    console.log(`[auto-sort/bridge] Published ${rules.length} rules to page.`);
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.rules) {
      publishRules(changes.rules.newValue);
      console.log("[auto-sort/bridge] Rules updated; republished.");
    }
  });
})();
