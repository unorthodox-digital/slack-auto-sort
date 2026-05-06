const DEFAULT_RULES = [
  { prefix: "vsl-", section: "VSL" },
  { prefix: "systems-", section: "Systems" },
  { prefix: "funnel-", section: "Funnel Build" },
];

const rulesContainer = document.getElementById("rules");
const statusEl = document.getElementById("status");

function createRuleRow(rule) {
  const div = document.createElement("div");
  div.className = "rule";
  div.innerHTML = `
    <input type="text" class="prefix" placeholder="vsl-" value="${rule.prefix}">
    <span class="arrow">→</span>
    <input type="text" class="section" placeholder="VSL" value="${rule.section}">
    <button class="btn btn-remove">✕</button>
  `;
  div.querySelector(".btn-remove").onclick = () => div.remove();
  return div;
}

function loadRules() {
  chrome.storage.sync.get({ rules: DEFAULT_RULES }, (data) => {
    rulesContainer.innerHTML = "";
    data.rules.forEach((r) => rulesContainer.appendChild(createRuleRow(r)));
  });
}

document.getElementById("add").onclick = () => {
  rulesContainer.appendChild(createRuleRow({ prefix: "", section: "" }));
};

document.getElementById("save").onclick = () => {
  const rules = [...rulesContainer.querySelectorAll(".rule")]
    .map((row) => ({
      prefix: row.querySelector(".prefix").value.trim().toLowerCase(),
      section: row.querySelector(".section").value.trim(),
    }))
    .filter((r) => r.prefix && r.section);

  chrome.storage.sync.set({ rules }, () => {
    statusEl.textContent = `Saved ${rules.length} rules`;
    setTimeout(() => (statusEl.textContent = ""), 2000);
  });
};

loadRules();
