const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
let lastDecision = null;
let lastAsk = null;

function showError(message) {
  const el = $("errorBanner");
  el.textContent = message;
  el.hidden = !message;
}

async function api(path, options, retried = false) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.code === "ACCESS_CODE_REQUIRED" && !retried) {
    const code = window.prompt("This Cani demo is protected. Access code:");
    if (code) {
      await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
      return api(path, options, true);
    }
  }
  if (!res.ok) {
    const issues = Array.isArray(body.issues) ? body.issues.join("; ") : body.error;
    throw new Error(issues || `request failed (${res.status})`);
  }
  return body;
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

function render(state) {
  const r = state.report;
  $("windowLabel").textContent = r.window.label;
  $("headroomAmount").textContent = money.format(r.headroom);
  $("valIncome").textContent = money.format(r.income);
  $("valCommitted").textContent = money.format(r.committed.total);
  $("valSpent").textContent = money.format(r.variableSpent);
  $("barIncome").style.width = "100%";
  $("barCommitted").style.width = pct(r.committed.total, r.income) + "%";
  $("barSpent").style.width = pct(r.variableSpent, r.income) + "%";

  $("committedList").innerHTML = r.committed.entries
    .map((e) => `<li><span>${escapeHtml(e.label)} <span class="meta">· ${e.cadence}</span></span><b>${money.format(e.monthly)}/mo</b></li>`)
    .join("") || "<li><span class='meta'>Nothing committed yet.</span></li>";
  $("plannedList").innerHTML = state.planned
    .map((p) => `<li><span>${escapeHtml(p.label)} <span class="meta">· ${p.when}</span></span><b>${money.format(p.amount)}</b></li>`)
    .join("") || "<li><span class='meta'>Nothing planned.</span></li>";
  $("decisionList").innerHTML = state.decisions
    .map((d) => `<li><span><span class="verdict-tag ${d.verdict === "YES" ? "yes" : "no"}">${d.verdict}</span> ${escapeHtml(d.label)} <span class="meta">· engine ${escapeHtml(d.engineVersion)}${d.adjustment ? ` · deeper (books: ${d.adjustment.rawVerdict})` : ""}</span></span><b>${money.format(d.amount)}</b></li>`)
    .join("") || "<li><span class='meta'>No asks yet. Your first verdict lands here.</span></li>";
  if (state.kept) {
    const el = $("keptChip");
    el.hidden = state.kept.amount <= 0;
    el.textContent = state.kept.amount > 0 ? `Kept by Cani this month: ${money.format(state.kept.amount)} (${state.kept.count} NO${state.kept.count === 1 ? "" : "s"})` : "";
  }
  if (state.shame) {
    const el = $("shameScore");
    el.hidden = state.shame.points <= 0;
    el.textContent = state.shame.points > 0 ? `Shame points this month: ${state.shame.points}` : "";
  }
  if (state.essentials) renderEssentials(state.essentials);
  if (state.goalHealth) {
    const gh = state.goalHealth;
    $("goalHealth").hidden = false;
    $("goalHealthTitle").textContent =
      gh.pattern === "systematic" ? "Your goal needs realigning" : gh.pattern === "occasional" ? "A pattern is forming" : "Goal vs. behavior";
    $("goalHealthText").textContent = gh.verdict + (gh.suggestedHorizon ? ` Suggested: stretch the horizon to ${gh.suggestedHorizon} and make the plan honest again.` : "");
    $("realignBtn").hidden = !gh.suggestedHorizon;
  }
  if (state.levels) {
    const feel = document.querySelector('[data-testid="tab-profile"]');
    if (feel) feel.textContent = state.levels.feel ? "Profile ✓" : "Profile";
    if ($("levelMonth")) $("levelMonth").textContent = state.levels.month ? "done — month in your books" : "not yet";
    if ($("levelPaypal")) $("levelPaypal").textContent = state.levels.paypal ? "connected" : "not connected";
  }
  renderProfile(state);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function refresh() {
  render(await api("/api/state"));
}

function renderVerdict(d, narration) {
  lastDecision = d;
  const box = $("verdict");
  box.hidden = false;
  box.className = "verdict " + (d.verdict === "YES" ? "yes" : "no");
  $("verdictWord").textContent = d.verdict;
  $("verdictSub").textContent = (d.verdict === "YES"
    ? `${money.format(d.amount)} for ${d.label} — approved.`
    : `${money.format(d.amount)} for ${d.label} — declined. Short by ${money.format(d.shortBy)}.`)
    + (d.adjustment ? ` Books alone said ${d.adjustment.rawVerdict}; deeper mode adjusted headroom by ${money.format(d.adjustment.total)}.` : "");
  $("verdictReasons").innerHTML = d.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("");
  // Bars only when the AI actually delivered validated bars — otherwise
  // the fallback is the plain verdict word above, nothing else.
  const duo = $("verdictDuo");
  if (d.adjustment) {
    duo.hidden = false;
    document.querySelector('[data-testid="books-verdict"]').textContent = `Books: ${d.adjustment.rawVerdict}`;
    document.querySelector('[data-testid="manager-verdict"]').textContent = `Manager: ${d.verdict}`;
  } else duo.hidden = true;
  const bars = $("verdictBars");
  if (narration && narration.mode === "bars") {
    bars.hidden = false;
    $("barsLines").innerHTML = narration.lines.map((l) => escapeHtml(l)).join("<br>");
  } else {
    bars.hidden = true;
  }
  const path = $("verdictPath");
  path.hidden = !d.pathToYes;
  path.textContent = d.pathToYes ?? "";
  // Teeth: a YES can be recorded as spend. A first NO gets no purchase
  // button at all; a second NO unlocks the shame-priced bypass.
  $("recordBtn").hidden = d.verdict !== "YES";
  $("paypalBtn").hidden = d.verdict !== "YES";
  $("paypalArea").hidden = true;
  $("noOverride").hidden = d.verdict !== "NO" || Boolean(d.bypassAvailable);
  $("shameBtn").hidden = !(d.verdict === "NO" && d.bypassAvailable);
  if (d.bypass?.category === "manual") {
    $("verdictSub").textContent += ` Shame +${d.bypass.shameAwarded} — the manager has noted this.`;
    if (d.goalImpact) $("verdictSub").textContent += ` ${d.goalImpact}`;
  } else if (d.bypass) {
    $("verdictSub").textContent += ` Essential lane (${d.bypass.category}) — no shame, this is life.`;
  }
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function parseItems(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^(.*?)[\s,]+\$?(\d+(?:\.\d{1,2})?)$/);
    return m ? { name: m[1].replace(/,+$/, ""), amount: Number(m[2]) } : null;
  }).filter(Boolean);
}

$("askForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  showError("");
  const amount = Number($("askAmount").value);
  const label = $("askLabel").value.trim() || "purchase";
  const merchant = $("askMerchant").value.trim() || undefined;
  const items = parseItems($("askItems").value);
  lastAsk = { amount, label, merchant, items: items.length ? items : undefined };
  try {
    const { decision, narration } = await api("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(lastAsk),
    });
    renderVerdict(decision, narration);
    await refresh();
  } catch (err) {
    showError(err.message);
  }
});

let pendingOrderId = null;
$("paypalBtn").addEventListener("click", async () => {
  if (!lastAsk) return;
  showError("");
  try {
    const result = await api("/api/checkout/attempt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(lastAsk),
    });
    const area = $("paypalArea");
    area.hidden = false;
    if (result.paypal?.order) {
      pendingOrderId = result.paypal.order.id;
      $("paypalNote2").textContent = `PayPal order ${pendingOrderId} created — because the answer was YES. Approve it, then complete the capture here.`;
      const link = $("paypalApprove");
      link.href = result.paypal.order.approveUrl ?? "#";
      link.hidden = !result.paypal.order.approveUrl;
      $("paypalCapture").hidden = false;
    } else {
      $("paypalNote2").textContent = result.paypal?.note ?? "";
      $("paypalApprove").hidden = true;
      $("paypalCapture").hidden = true;
    }
  } catch (err) {
    showError(err.message);
  }
});

$("paypalCapture").addEventListener("click", async () => {
  if (!pendingOrderId) return;
  showError("");
  try {
    const state = await api("/api/paypal/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: pendingOrderId }),
    });
    pendingOrderId = null;
    $("verdict").hidden = true;
    render(state);
  } catch (err) {
    showError(err.message);
  }
});

$("shameBtn").addEventListener("click", async () => {
  if (!lastAsk) return;
  showError("");
  try {
    const { decision, narration } = await api("/api/ask/manual-bypass", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(lastAsk),
    });
    renderVerdict(decision, narration);
    await refresh();
  } catch (err) {
    showError(err.message);
  }
});

const LANE_LABELS = { fuel: "Fuel", pharmacy: "Pharmacy & medicine", groceries: "Groceries" };
function renderEssentials(config) {
  $("essentialsList").innerHTML = Object.entries(LANE_LABELS).map(([key, label]) => `
    <label class="ess-row">
      <input type="checkbox" data-testid="essentials-${key}-enabled" data-lane="${key}" data-part="enabled" ${config[key].enabled ? "checked" : ""}>
      <span>${label}</span>
      <span>up to $</span>
      <input type="number" min="1" step="1" data-testid="essentials-${key}-cap" data-lane="${key}" data-part="cap" value="${config[key].cap}">
    </label>`).join("");
}

$("saveEssentials").addEventListener("click", async () => {
  const config = {};
  for (const key of Object.keys(LANE_LABELS)) {
    config[key] = {
      enabled: document.querySelector(`[data-lane="${key}"][data-part="enabled"]`).checked,
      cap: Number(document.querySelector(`[data-lane="${key}"][data-part="cap"]`).value),
    };
  }
  showError("");
  try {
    await api("/api/essentials", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    await refresh();
  } catch (err) {
    showError(err.message);
  }
});

$("recordBtn").addEventListener("click", async () => {
  if (!lastDecision || lastDecision.verdict !== "YES") return;
  showError("");
  try {
    const state = await api("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: lastDecision.amount, label: lastDecision.label }),
    });
    $("verdict").hidden = true;
    render(state);
  } catch (err) {
    showError(err.message);
  }
});

$("spendForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  showError("");
  try {
    const state = await api("/api/spend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amount: Number($("spendAmount").value),
        label: $("spendLabel").value.trim() || "spend",
      }),
    });
    ev.target.reset();
    render(state);
  } catch (err) {
    showError(err.message);
  }
});

// --- Tabs: Cani / Profile / Upload ---------------------------------------
function activateTab(name) {
  document.querySelectorAll("[data-tab-btn]").forEach((b) => {
    const active = b.dataset.tabBtn === name;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-tab]").forEach((panel) => {
    // The verdict panel has its own lifecycle: hidden until an ask lands,
    // restored when returning to the Cani tab after one.
    if (panel.id === "verdict") {
      panel.hidden = name !== "cani" || !lastDecision;
      return;
    }
    panel.hidden = panel.dataset.tab !== name;
  });
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document.querySelectorAll("[data-tab-btn]").forEach((b) => {
  b.addEventListener("click", () => activateTab(b.dataset.tabBtn));
});
activateTab(["profile", "upload"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "cani");

// --- Deeper mode: the who-am-I tree -------------------------------------
const profileDraft = { securityDial: 50, enjoyDial: 50, familyDial: 50, adjustmentEnabled: true };
const PROFILE_FIELDS = ["ageBand", "housing", "dependents", "familyStatus", "goal", "horizon", "temperament"];
const DIAL_FIELDS = [["securityDial", "dialSecurity"], ["enjoyDial", "dialEnjoy"], ["familyDial", "dialFamily"]];

function syncChips() {
  document.querySelectorAll(".chips[data-field]").forEach((group) => {
    const field = group.dataset.field;
    // Unanswered groups blink until the user picks — guidance, not decoration.
    group.classList.toggle("unfilled", !profileDraft[field]);
    group.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("selected", profileDraft[field] === b.dataset.value);
    });
  });
  $("profileState").classList.toggle("unfilled", !$("profileState").value);
  for (const [field, id] of DIAL_FIELDS) $(id).value = profileDraft[field];
  const ready = PROFILE_FIELDS.every((f) => profileDraft[f]) && $("profileState").value;
  $("saveProfile").disabled = !ready;
  renderCharacter();
}

for (const [field, id] of DIAL_FIELDS) {
  $(id).addEventListener("input", (ev) => {
    profileDraft[field] = Number(ev.target.value);
    renderCharacter();
  });
}

document.querySelectorAll(".chips").forEach((group) => {
  group.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    profileDraft[group.dataset.field] = btn.dataset.value;
    syncChips();
  });
});
$("profileState").addEventListener("change", syncChips);
$("adjustmentEnabled").addEventListener("change", (ev) => { profileDraft.adjustmentEnabled = ev.target.checked; });

function renderCharacter() {
  const p = profileDraft;
  const hair = p.ageBand === "60-plus" ? "#e8e8e8" : p.ageBand === "50s" ? "#9a9a9a" : "#222222";
  const home = p.housing === "paid-off"
    ? '<polygon points="20,70 60,38 100,70" fill="#e03a1e" stroke="#111" stroke-width="3"/><rect x="32" y="70" width="56" height="44" fill="#fff" stroke="#111" stroke-width="3"/><rect x="86" y="46" width="52" height="22" fill="#ffd21f" stroke="#111" stroke-width="2" transform="rotate(4 112 57)"/><text x="112" y="62" font-size="11" font-weight="900" text-anchor="middle">PAID!</text>'
    : p.housing === "mortgage"
      ? '<polygon points="20,70 60,38 100,70" fill="#ff7a1a" stroke="#111" stroke-width="3"/><rect x="32" y="70" width="56" height="44" fill="#fff" stroke="#111" stroke-width="3"/>'
      : p.housing === "renting"
        ? '<rect x="26" y="30" width="52" height="84" fill="#fff" stroke="#111" stroke-width="3"/><rect x="36" y="42" width="12" height="12" fill="#ffd21f" stroke="#111" stroke-width="2"/><rect x="56" y="42" width="12" height="12" fill="#ffd21f" stroke="#111" stroke-width="2"/><rect x="36" y="64" width="12" height="12" fill="#ffd21f" stroke="#111" stroke-width="2"/><rect x="56" y="64" width="12" height="12" fill="#ffd21f" stroke="#111" stroke-width="2"/>'
        : '<circle cx="52" cy="52" r="30" fill="#ffd21f" stroke="#111" stroke-width="3"/>';
  const partner = (p.familyStatus === "married-dual-income" || p.familyStatus === "married-stay-home" || p.familyStatus === "dating" || p.familyStatus === "co-parenting")
    ? '<circle cx="215" cy="86" r="15" fill="#ffd9c2" stroke="#111" stroke-width="3"/><rect x="200" y="101" width="30" height="42" fill="#1d9e4b" stroke="#111" stroke-width="3"/>'
    : "";
  const atHomeBadge = p.familyStatus === "married-stay-home"
    ? '<rect x="188" y="126" width="72" height="18" fill="#fff" stroke="#111" stroke-width="2"/><text x="224" y="139" font-size="10" font-weight="900" text-anchor="middle">HOME BASE</text>' : "";
  const kidCount = p.dependents === "kids-daycare" || p.dependents === "kids-school" ? 2 : p.dependents === "kids-and-parents" ? 2 : p.familyStatus === "single-parent" ? 1 : 0;
  let kids = "";
  for (let i = 0; i < kidCount; i++) {
    kids += `<circle cx="${246 + i * 24}" cy="106" r="9" fill="#ffd9c2" stroke="#111" stroke-width="2"/><rect x="${239 + i * 24}" y="115" width="14" height="24" fill="#e03a1e" stroke="#111" stroke-width="2"/>`;
  }
  const shades = p.temperament === "live-a-little" || profileDraft.enjoyDial >= 65
    ? '<rect x="156" y="72" width="34" height="10" fill="#111"/><rect x="160" y="82" width="6" height="10" fill="#111"/><rect x="180" y="82" width="6" height="10" fill="#111"/>' : "";
  const shield = p.temperament === "careful" || profileDraft.securityDial <= 35
    ? '<path d="M128 108 l16 -7 v14 c0 12 -7 20 -16 24 c-9 -4 -16 -12 -16 -24 v-14z" fill="#ffd21f" stroke="#111" stroke-width="2"/>' : "";
  $("charScene").innerHTML =
    `<rect width="300" height="170" fill="#ffffff"/><circle cx="262" cy="26" r="15" fill="#ffd21f" stroke="#111" stroke-width="3"/>`
    + home + partner + kids + atHomeBadge
    + `<circle cx="173" cy="80" r="19" fill="#ffd9c2" stroke="#111" stroke-width="3"/><path d="M154 76 a19 15 0 0 1 38 0z" fill="${hair}"/>`
    + shades
    + `<rect x="155" y="99" width="36" height="48" fill="#ffd21f" stroke="#111" stroke-width="3"/>` + shield
    + '<rect y="147" width="300" height="23" fill="#111"/><text x="150" y="163" fill="#ffd21f" font-size="12" font-weight="900" text-anchor="middle" letter-spacing="2">THIS IS YOU, ON PAPER</text>';
  const bits = [];
  if (p.ageBand) bits.push(`in your ${p.ageBand === "60-plus" ? "60s+" : p.ageBand}`);
  if (p.housing === "paid-off") bits.push("house paid off");
  if (p.familyStatus === "married-stay-home") bits.push("one-income household, partner holds home base");
  if (p.familyStatus === "married-dual-income") bits.push("two incomes");
  if (kidCount) bits.push("kids in the frame");
  if (p.temperament === "live-a-little") bits.push("shades on");
  $("charCaption").textContent = bits.length ? `That's you: ${bits.join(", ")}.` : "Pick answers below — your character shows up here.";
}

function renderProfile(state) {
  if (state.profile) {
    for (const f of PROFILE_FIELDS) profileDraft[f] = state.profile[f];
    for (const [field] of DIAL_FIELDS) if (state.profile[field] !== undefined) profileDraft[field] = state.profile[field];
    if (state.profile.adjustmentEnabled !== undefined) { profileDraft.adjustmentEnabled = state.profile.adjustmentEnabled; $("adjustmentEnabled").checked = state.profile.adjustmentEnabled; }
    if (state.profile.state) $("profileState").value = state.profile.state;
    syncChips();
  }
  const box = $("insight");
  if (!state.insight) { box.hidden = true; return; }
  box.hidden = false;
  $("insightArchetype").textContent = state.insight.archetype;
  $("insightNotes").innerHTML = state.insight.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("");
  $("insightMeta").textContent = `Suggested buffer: ${money.format(state.insight.suggestedBuffer)} (${state.insight.suggestedBufferMonths} months of committed). State data: bundled approximations, ${state.statesAsOf}.`;
}

$("saveProfile").addEventListener("click", async () => {
  showError("");
  try {
    const body = { ...profileDraft, state: $("profileState").value };
    const saved = await api("/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    renderProfile({ profile: saved.profile, insight: saved.insight, statesAsOf: "saved" });
    await refresh();
  } catch (err) {
    showError(err.message);
  }
});

// AI draft: fills the tree, saves nothing.
$("draftBtn").addEventListener("click", async () => {
  const text = $("freeText").value.trim();
  if (!text) { showError("Tell Cani a sentence or two first."); return; }
  showError("");
  try {
    const result = await api("/api/profile/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    for (const f of PROFILE_FIELDS) if (result.draft[f]) profileDraft[f] = result.draft[f];
    for (const [field] of DIAL_FIELDS) if (result.draft[field] !== undefined) profileDraft[field] = result.draft[field];
    if (result.draft.state) $("profileState").value = result.draft.state;
    syncChips();
    const note = $("draftNote");
    note.hidden = false;
    note.textContent = `${result.narrative} (${result.note})`;
    note.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    showError(err.message);
  }
});

// Money blot: five cards, deterministic suggestion, applied only on tap.
let blotCards = [];
let blotAnswers = [];
let blotSuggestion = null;

function renderBlotCard() {
  const card = blotCards[blotAnswers.length];
  if (!card) return;
  $("blotPrompt").textContent = card.prompt;
  $("blotProgress").textContent = `Card ${blotAnswers.length + 1} of ${blotCards.length}`;
  $("blotChoices").innerHTML = "";
  for (const choice of card.choices) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.testid = "blot-choice";
    b.textContent = choice.label;
    b.addEventListener("click", async () => {
      blotAnswers.push({ cardId: card.id, choiceId: choice.id });
      if (blotAnswers.length < blotCards.length) { renderBlotCard(); return; }
      try {
        const result = await api("/api/blot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers: blotAnswers }),
        });
        blotSuggestion = result.suggestion;
        $("blotArea").hidden = true;
        $("blotResult").hidden = false;
        $("blotReasons").innerHTML = result.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")
          + `<li><b>Suggested:</b> ${Object.entries(result.suggestion).filter(([, v]) => v).map(([k, v]) => `${k}: ${escapeHtml(String(v))}`).join(", ")}</li>`;
      } catch (err) {
        showError(err.message);
      }
    });
    $("blotChoices").appendChild(b);
  }
}

$("blotStart").addEventListener("click", async () => {
  showError("");
  try {
    const { cards } = await api("/api/blot");
    blotCards = cards;
    blotAnswers = [];
    blotSuggestion = null;
    $("blotResult").hidden = true;
    $("blotArea").hidden = false;
    renderBlotCard();
  } catch (err) {
    showError(err.message);
  }
});

$("blotApply").addEventListener("click", () => {
  if (!blotSuggestion) return;
  for (const f of ["temperament", "goal", "horizon"]) {
    if (blotSuggestion[f]) profileDraft[f] = blotSuggestion[f];
  }
  syncChips();
  $("profileTree").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

// Level 2: typical-month ingest (propose → confirm → apply).
let monthProposal = null;

function showProposal(proposal) {
  monthProposal = proposal;
  $("proposal").hidden = false;
  $("proposalSummary").textContent =
    `${proposal.rowCount} rows · income ${money.format(proposal.income)} · everyday spend ${money.format(proposal.variableSpent)} · ${proposal.candidates.length} committed candidate(s) found. Tick only what's genuinely committed:`;
  $("candidateList").innerHTML = proposal.candidates
    .map((c, i) => `<label class="candidate"><input type="checkbox" data-candidate="${i}" checked> ${escapeHtml(c.label)} — ${money.format(c.amount)}/mo <span class="meta">(looks like ${escapeHtml(c.hint)})</span></label>`)
    .join("") || "<p class='meta-line'>No committed candidates spotted — the month still counts as spend history.</p>";
}

async function ingestCsv(csv) {
  showError("");
  try {
    const { proposal } = await api("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csv }),
    });
    showProposal(proposal);
  } catch (err) {
    showError(err.message);
  }
}

$("csvFile").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (file) await ingestCsv(await file.text());
});

$("sampleMonth").addEventListener("click", async () => {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  await ingestCsv([
    "date,description,amount",
    `${ym}-01,Paycheck,3200`,
    `${ym}-03,Sample Mortgage,-950`,
    `${ym}-05,Daycare Center,-410`,
    `${ym}-07,Coffee Shop,-6.50`,
    `${ym}-09,Grocery Store,-132.20`,
  ].join("\n"));
});

$("applyMonth").addEventListener("click", async () => {
  if (!monthProposal) return;
  const confirmCandidateIndexes = [...document.querySelectorAll("[data-candidate]")]
    .filter((el) => el.checked).map((el) => Number(el.dataset.candidate));
  showError("");
  try {
    const result = await api("/api/ingest/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows: monthProposal.rows, confirmCandidateIndexes }),
    });
    $("applyResult").textContent =
      `Added ${result.appended} ledger row(s)${result.skippedDuplicates ? `, skipped ${result.skippedDuplicates} duplicate(s)` : ""}. Committed confirmed: ${result.committedAdded.join(", ") || "none"}.`;
    render(result);
  } catch (err) {
    showError(err.message);
  }
});

// Level 3: PayPal capability check.
async function loadPaypal() {
  try {
    const s = await api("/api/paypal/status");
    $("levelPaypal").textContent = !s.configured
      ? "not connected"
      : s.verification?.verified ? `connected (${s.mode}) ✓` : `credentials set (${s.mode}) — unverified`;
    $("paypalNote").textContent = s.configured
      ? `${s.verification?.detail ?? ""} Next: checkout and funding orders run on these rails.`
      : "Set CANI_PAYPAL_CLIENT_ID and CANI_PAYPAL_CLIENT_SECRET (sandbox keys from developer.paypal.com) in the server environment, then restart. It cannot read your bank statements — your books stay Upload + your word.";
  } catch { $("levelPaypal").textContent = "unknown"; }
}

async function loadStates() {
  try {
    const { states } = await api("/api/states");
    $("profileState").innerHTML = '<option value="">Choose a state…</option>' + states
      .map((s) => `<option value="${s.code}">${escapeHtml(s.name)} · index ${s.colIndex}</option>`).join("");
  } catch { /* the tree still works; state can be picked after reconnect */ }
}

syncChips();
loadStates();
loadPaypal();
refresh().catch((err) => showError(`Could not load your books: ${err.message}`));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

$("realignBtn").addEventListener("click", async () => {
  showError("");
  try {
    await api("/api/profile/realign", { method: "POST" });
    await refresh();
  } catch (err) {
    showError(err.message);
  }
});
