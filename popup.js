const DEFAULT_RULES = [
  { prefix: "vsl-", section: "VSL" },
  { prefix: "systems-", section: "Systems" },
  { prefix: "funnel-", section: "Funnel Build" },
];

const DEFAULT_AUTOREAD = [];
const DEFAULT_AUTOREAD_INVITES = [];
const DEFAULT_AUTOREAD_BROADCASTS = [];

const rulesContainer = document.getElementById("rules");
const autoreadContainer = document.getElementById("autoread");
const autoreadInvitesContainer = document.getElementById("autoread-invites");
const autoreadBroadcastsContainer = document.getElementById("autoread-broadcasts");
const statusEl = document.getElementById("status");

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function createRuleRow(rule) {
  const div = document.createElement("div");
  div.className = "rule";
  div.innerHTML = `
    <input type="text" class="prefix" placeholder="vsl-" value="${escape(rule.prefix || "")}">
    <span class="arrow">→</span>
    <input type="text" class="section" placeholder="VSL" value="${escape(rule.section || "")}">
    <button class="btn btn-remove" title="Remove">✕</button>
  `;
  div.querySelector(".btn-remove").onclick = () => div.remove();
  return div;
}

function createPrefixRow(prefix) {
  const div = document.createElement("div");
  div.className = "rule";
  div.innerHTML = `
    <input type="text" class="prefix" placeholder="vsl-" value="${escape(prefix || "")}">
    <button class="btn btn-remove" title="Remove">✕</button>
  `;
  div.querySelector(".btn-remove").onclick = () => div.remove();
  return div;
}

function loadAll() {
  chrome.storage.sync.get(
    {
      rules: DEFAULT_RULES,
      autoReadPrefixes: DEFAULT_AUTOREAD,
      autoReadInvitePrefixes: DEFAULT_AUTOREAD_INVITES,
      autoReadBroadcastPrefixes: DEFAULT_AUTOREAD_BROADCASTS,
    },
    (data) => {
      rulesContainer.innerHTML = "";
      data.rules.forEach((r) => rulesContainer.appendChild(createRuleRow(r)));
      autoreadContainer.innerHTML = "";
      data.autoReadPrefixes.forEach((p) => autoreadContainer.appendChild(createPrefixRow(p)));
      autoreadInvitesContainer.innerHTML = "";
      data.autoReadInvitePrefixes.forEach((p) => autoreadInvitesContainer.appendChild(createPrefixRow(p)));
      autoreadBroadcastsContainer.innerHTML = "";
      data.autoReadBroadcastPrefixes.forEach((p) => autoreadBroadcastsContainer.appendChild(createPrefixRow(p)));
    }
  );
}

document.getElementById("add-rule").onclick = () => {
  rulesContainer.appendChild(createRuleRow({ prefix: "", section: "" }));
};

document.getElementById("add-autoread").onclick = () => {
  autoreadContainer.appendChild(createPrefixRow(""));
};

document.getElementById("add-autoread-invite").onclick = () => {
  autoreadInvitesContainer.appendChild(createPrefixRow(""));
};

document.getElementById("add-autoread-broadcast").onclick = () => {
  autoreadBroadcastsContainer.appendChild(createPrefixRow(""));
};

document.getElementById("save").onclick = () => {
  const rules = [...rulesContainer.querySelectorAll(".rule")]
    .map((row) => ({
      prefix: row.querySelector(".prefix").value.trim().toLowerCase(),
      section: row.querySelector(".section").value.trim(),
    }))
    .filter((r) => r.prefix && r.section);

  const autoReadPrefixes = [...autoreadContainer.querySelectorAll(".rule")]
    .map((row) => row.querySelector(".prefix").value.trim().toLowerCase())
    .filter((p) => p);

  const autoReadInvitePrefixes = [...autoreadInvitesContainer.querySelectorAll(".rule")]
    .map((row) => row.querySelector(".prefix").value.trim().toLowerCase())
    .filter((p) => p);

  const autoReadBroadcastPrefixes = [...autoreadBroadcastsContainer.querySelectorAll(".rule")]
    .map((row) => row.querySelector(".prefix").value.trim().toLowerCase())
    .filter((p) => p);

  chrome.storage.sync.set(
    { rules, autoReadPrefixes, autoReadInvitePrefixes, autoReadBroadcastPrefixes },
    () => {
      statusEl.textContent = `Saved: ${rules.length} sort, ${autoReadPrefixes.length} full, ${autoReadInvitePrefixes.length} invites, ${autoReadBroadcastPrefixes.length} broadcasts.`;
      setTimeout(() => (statusEl.textContent = ""), 2500);
    }
  );
};

loadAll();
