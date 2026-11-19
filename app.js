"use strict";

/* ===== Constants ===== */
const DB_NAME = "triad-db";
const DB_VERSION = 1;
const STORE = "entries";
const THEME_KEY = "triad-theme";
const DAY_MS = 86400000;
const MIN_ENTRIES_FOR_INSIGHTS = 3; // no pattern claims from fewer check-ins than this
const EXPORT_SCHEMA_VERSION = 1;
// Placeholder values saved when a chip is skipped. They are never treated as a real pattern.
const UNSET_VALUES = ["Uncategorised", "Not tagged"];

/* ===== State ===== */
let db;
let entries = [];
// Form state and view state are kept apart so resetting the form can never wipe the view.
const form = { context: null, distortion: null, response: null, step: 0 };
const view = { period: "week", calDate: monthStart(new Date()), selectedDate: new Date() };

/* ===== Small helpers ===== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random();
}
function monthStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function daysAgo(n) {
  return Date.now() - n * DAY_MS;
}
function within(e, days) {
  return e.createdAt >= daysAgo(days);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}
function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function isSet(v) {
  return typeof v === "string" && v !== "" && !UNSET_VALUES.includes(v);
}
function getSetting(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}
function setSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {
    /* storage blocked: the setting just won't persist */
  }
}
function showStorageError(message) {
  const el = $("#storageError");
  el.textContent = message;
  el.classList.remove("hidden");
}
function clearStorageError() {
  $("#storageError").classList.add("hidden");
}

/* ===== IndexedDB ===== */
function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => {
      db = r.result;
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("Database blocked by another tab"));
  });
}

// Runs one transaction and resolves only once it has committed (tx.oncomplete),
// not merely when the request succeeded.
function runTx(mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result;
    const req = work(tx.objectStore(STORE));
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}
const allEntries = () => runTx("readonly", (s) => s.getAll()).then((list) => list.sort((a, b) => b.createdAt - a.createdAt));
const saveEntry = (e) => runTx("readwrite", (s) => s.put(e));
const saveMany = (list) => runTx("readwrite", (s) => { list.forEach((e) => s.put(e)); });
const deleteAll = () => runTx("readwrite", (s) => s.clear());

function requestPersistentStorage() {
  // Asks the browser not to evict our data under storage pressure. Best effort.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

/* ===== Navigation ===== */
function renderNav(name) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  $$(".bottom-nav button").forEach((b) => b.classList.toggle("active", b.dataset.nav === name));
  if (name === "home") renderHome();
  if (name === "insights") renderInsights();
  if (name === "journal") renderCalendar();
}
$$("[data-nav]").forEach((b) => b.addEventListener("click", () => renderNav(b.dataset.nav)));
$("#quickAdd").onclick = () => {
  resetForm();
  renderNav("log");
};

/* ===== Check-in form ===== */
function resetForm() {
  form.context = null;
  form.distortion = null;
  form.response = null;
  form.step = 0;
  $("#entryForm").reset();
  $$(".chips button").forEach((b) => {
    b.classList.remove("selected");
    b.setAttribute("aria-pressed", "false");
  });
  $("#intensityOut").textContent = $("#intensity").value;
  $("#helpfulOut").textContent = $("#helpful").value;
  showStep();
}
function showStep() {
  $$(".step").forEach((s, i) => s.classList.toggle("active", i === form.step));
  $$(".progress i").forEach((x, i) => x.classList.toggle("active", i <= form.step));
}
function next() {
  if (form.step >= 2) return;
  if (form.step === 0 && !$("#situation").value.trim()) return $("#situation").focus();
  if (form.step === 1 && !$("#thought").value.trim()) return $("#thought").focus();
  form.step++;
  showStep();
}
$$(".next").forEach((b) => (b.onclick = next));
$$(".prev").forEach((b) => (b.onclick = () => {
  if (form.step > 0) {
    form.step--;
    showStep();
  }
}));

function chipGroup(selector, key) {
  const buttons = $$(`${selector} button`);
  buttons.forEach((b) => {
    b.setAttribute("aria-pressed", "false");
    b.onclick = () => {
      buttons.forEach((x) => {
        x.classList.remove("selected");
        x.setAttribute("aria-pressed", "false");
      });
      b.classList.add("selected");
      b.setAttribute("aria-pressed", "true");
      form[key] = b.dataset.value;
    };
  });
}
chipGroup('[data-target="context"]', "context");
chipGroup("#distortionChips", "distortion");
chipGroup("#behaviourChips", "response");

$("#intensity").oninput = (e) => ($("#intensityOut").textContent = e.target.value);
$("#helpful").oninput = (e) => ($("#helpfulOut").textContent = e.target.value);

$("#entryForm").onsubmit = async (e) => {
  e.preventDefault();
  if (!$("#behaviour").value.trim()) return;
  const entry = {
    id: uid(),
    createdAt: Date.now(),
    situation: $("#situation").value.trim(),
    context: form.context || "Uncategorised",
    intensity: +$("#intensity").value,
    thought: $("#thought").value.trim(),
    distortion: form.distortion || "Not tagged",
    behaviour: $("#behaviour").value.trim(),
    response: form.response || "Not tagged",
    helpful: +$("#helpful").value,
  };
  try {
    await saveEntry(entry);
    entries = await allEntries();
  } catch (err) {
    // Stay on the form so the text is not lost.
    showStorageError("Could not save this check-in. Your text is still on screen, so try again or copy it somewhere safe.");
    return;
  }
  clearStorageError();
  requestPersistentStorage();
  resetForm();
  renderNav("home");
};

/* ===== Home ===== */
function renderHome() {
  const recent = entries.slice(0, 5);
  $("#recentEntries").innerHTML = recent.length
    ? recent.map(entryHTML).join("")
    : `<div class="entry"><p>No check-ins yet. Your first entry creates the baseline for your pattern map.</p></div>`;
  const week = entries.filter((e) => within(e, 7));
  const distinct = (key) => new Set(week.map((e) => e[key]).filter(isSet)).size;
  $("#miniPattern").innerHTML = [["Situations", week.length], ["Thought styles", distinct("distortion")], ["Behaviours", distinct("response")]]
    .map((x) => `<div class="pattern-card"><strong>${x[1]}</strong><span>${x[0]}</span></div>`)
    .join("");
  const insight = buildInsights(week)[0];
  let title = "Start logging to reveal your patterns.";
  let body = "Your insights become more useful as repeated situations, thoughts and behaviours accumulate.";
  if (insight) {
    title = insight.title;
    body = insight.body;
  } else if (entries.length) {
    title = "Keep logging to reveal your patterns.";
    body = `Insights appear once you have at least ${MIN_ENTRIES_FOR_INSIGHTS} check-ins in the last 7 days.`;
  }
  $("#headlineInsight").querySelector("h3").textContent = title;
  $("#headlineInsight").querySelector("p").textContent = body;
}
function entryHTML(e) {
  return `<article class="entry"><div class="entry-top"><span class="entry-date">${formatDate(e.createdAt)}</span><span class="pill">${esc(e.context)}</span></div><h3>${esc(e.situation)}</h3><p><b>Thought:</b> ${esc(e.thought)}</p><p><b>Behaviour:</b> ${esc(e.behaviour)}</p><span class="pill">${esc(e.distortion)}</span><span class="pill">${esc(e.response)}</span></article>`;
}

/* ===== Insights ===== */
function countsBy(es, key) {
  const m = {};
  es.forEach((e) => {
    if (isSet(e[key])) m[e[key]] = (m[e[key]] || 0) + 1;
  });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function buildInsights(es) {
  if (es.length < MIN_ENTRIES_FOR_INSIGHTS) return [];
  const out = [];
  const ctx = countsBy(es, "context")[0];
  const dist = countsBy(es, "distortion")[0];
  const resp = countsBy(es, "response")[0];
  const avg = es.reduce((a, e) => a + (Number(e.intensity) || 0), 0) / es.length;
  // "Frequent" and "repeatedly" need at least two occurrences.
  if (ctx && ctx[1] >= 2) {
    out.push({
      title: `${ctx[0]} is a frequent context`,
      body: `It appeared in ${ctx[1]} of ${es.length} recent check-ins. Compare what changes in your thoughts and behaviour when the context changes.`,
    });
  }
  if (dist && dist[1] >= 2) {
    out.push({
      title: `“${dist[0]}” is showing up repeatedly`,
      body: `You tagged this thinking style ${dist[1]} times. Treat it as a hypothesis to examine, not a label about who you are.`,
    });
  }
  if (resp && resp[1] >= 2) {
    out.push({
      title: `Your common response is ${resp[0].toLowerCase()}`,
      body: `This response appeared ${resp[1]} times. Look at the short-term relief versus the longer-term effect in the entries behind it.`,
    });
  }
  out.push({
    title: `Average situation intensity: ${avg.toFixed(1)}/10`,
    body: "Intensity alone does not explain the pattern. Compare high-intensity situations with the thoughts and behaviours that followed.",
  });
  return out;
}

function renderInsights() {
  const es = entries.filter((e) => within(e, view.period === "week" ? 7 : 30));
  const ins = buildInsights(es);
  const emptyText = es.length
    ? `Patterns appear once you have at least ${MIN_ENTRIES_FOR_INSIGHTS} check-ins in this period.`
    : "Not enough data for this period yet.";
  $("#insightSummary").innerHTML =
    ins.map((i) => `<div class="insight-card"><div class="insight-icon">✦</div><div><h3>${esc(i.title)}</h3><p>${esc(i.body)}</p></div></div>`).join("") ||
    `<div class="entry"><p>${emptyText}</p></div>`;

  const groups = [["Situation", "context"], ["Thought", "distortion"], ["Behaviour", "response"]];
  $("#layerMap").innerHTML = groups
    .map(([name, key]) => {
      const top = countsBy(es, key)[0];
      return `<div class="layer"><b>${name}</b><p>${top ? `Most common: <strong>${esc(top[0])}</strong> (${top[1]}×)` : "No data yet."}</p></div>`;
    })
    .join("");

  const blind = [];
  if (es.length >= 4) {
    const avoided = es.filter((e) => /avoid|withdrew|silence/i.test(String(e.response ?? ""))).length;
    if (avoided / es.length >= 0.5) {
      blind.push(["Relief may be reinforcing avoidance", "A large share of entries contains avoidance or withdrawal. Review whether the behaviour reduced discomfort immediately but kept the original problem unchanged."]);
    }
    const high = es.filter((e) => e.intensity >= 8);
    if (high.length >= 2) {
      blind.push(["High-intensity moments deserve a closer look", `${high.length} entries were rated 8/10 or higher. Compare their situations to see whether a recurring trigger is present.`]);
    }
  }
  $("#blindSpots").innerHTML = blind.length
    ? blind.map((x) => `<div class="blind"><strong>${x[0]}</strong><p>${x[1]}</p></div>`).join("")
    : `<div class="blind"><strong>No blind spot hypothesis yet</strong><p>Keep logging. The app will only surface a pattern when there is enough repeated evidence.</p></div>`;

  $$("[data-period]").forEach((b) => b.classList.toggle("active", b.dataset.period === view.period));
}
$$("[data-period]").forEach((b) => (b.onclick = () => {
  view.period = b.dataset.period;
  renderInsights();
}));
$("#refreshInsights").onclick = renderInsights;

/* ===== Timeline ===== */
function renderCalendar() {
  const d = view.calDate;
  const y = d.getFullYear();
  const m = d.getMonth();
  $("#calendarTitle").textContent = d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const entryDays = new Set(entries.map((e) => new Date(e.createdAt).toDateString()));
  const selectedKey = view.selectedDate.toDateString();
  let h = ["S", "M", "T", "W", "T", "F", "S"].map((x) => `<div class="cal-head">${x}</div>`).join("");
  for (let i = 0; i < first; i++) h += "<div></div>";
  for (let day = 1; day <= days; day++) {
    const key = new Date(y, m, day).toDateString();
    h += `<button class="cal-day ${entryDays.has(key) ? "has" : ""} ${selectedKey === key ? "selected" : ""}" data-day="${day}">${day}</button>`;
  }
  $("#calendar").innerHTML = h;
  $$(".cal-day").forEach((b) => (b.onclick = () => {
    view.selectedDate = new Date(y, m, +b.dataset.day);
    renderCalendar();
  }));
  const dayEntries = entries.filter((e) => new Date(e.createdAt).toDateString() === selectedKey);
  $("#selectedDateTitle").textContent = view.selectedDate.toLocaleDateString(undefined, { day: "numeric", month: "long" });
  $("#selectedCount").textContent = dayEntries.length ? `${dayEntries.length} check-in${dayEntries.length > 1 ? "s" : ""}` : "";
  $("#dayEntries").innerHTML = dayEntries.map(entryHTML).join("") || `<div class="entry"><p>No entries for this day.</p></div>`;
}
// Always build the new month from day 1, so the 29th to 31st can never overflow into the next month.
function shiftMonth(delta) {
  view.calDate = new Date(view.calDate.getFullYear(), view.calDate.getMonth() + delta, 1);
  renderCalendar();
}
$("#prevMonth").onclick = () => shiftMonth(-1);
$("#nextMonth").onclick = () => shiftMonth(1);

/* ===== Settings ===== */
function applyTheme(t) {
  document.body.classList.toggle("dark", t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches));
  setSetting(THEME_KEY, t);
}
$("#theme").onchange = (e) => applyTheme(e.target.value);
const savedTheme = getSetting(THEME_KEY, "system");
applyTheme(savedTheme);
$("#theme").value = savedTheme;

$("#exportBtn").onclick = () => {
  const payload = { app: "triad", schemaVersion: EXPORT_SCHEMA_VERSION, exportedAt: new Date().toISOString(), entries };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `triad-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// Validates one imported record and keeps only the known fields. Returns null if it is unusable.
function cleanEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const str = (v) => (typeof v === "string" ? v : null);
  const rating = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 && n <= 10 ? Math.round(n) : null;
  };
  const id = str(raw.id);
  const situation = str(raw.situation)?.trim();
  const thought = str(raw.thought)?.trim();
  const behaviour = str(raw.behaviour)?.trim();
  const createdAt = Number(raw.createdAt);
  const intensity = rating(raw.intensity);
  const helpful = rating(raw.helpful);
  if (!id || !situation || !thought || !behaviour || !Number.isFinite(createdAt) || createdAt <= 0 || intensity === null || helpful === null) return null;
  return {
    id,
    createdAt,
    situation,
    context: str(raw.context) || "Uncategorised",
    intensity,
    thought,
    distortion: str(raw.distortion) || "Not tagged",
    behaviour,
    response: str(raw.response) || "Not tagged",
    helpful,
  };
}

$("#importBtn").onclick = () => $("#importFile").click();
$("#importFile").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const status = $("#importStatus");
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data && Array.isArray(data.entries) ? data.entries : null; // a bare array is the old export format
    if (!list) throw new Error("This file is not a Triad export.");
    if (data.schemaVersion > EXPORT_SCHEMA_VERSION) throw new Error("This export was made by a newer version of Triad.");
    const good = list.map(cleanEntry).filter(Boolean);
    const skipped = list.length - good.length;
    if (good.length) await saveMany(good); // same id overwrites, so importing twice never duplicates
    entries = await allEntries();
    status.textContent = `Imported ${good.length} check-in${good.length === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} invalid` : ""}.`;
  } catch (err) {
    status.textContent = err instanceof SyntaxError ? "That file is not valid JSON." : err.message || "Import failed.";
  }
};

$("#clearBtn").onclick = async () => {
  if (!confirm("Delete all local Triad data? This cannot be undone.")) return;
  try {
    await deleteAll();
    entries = [];
    renderHome();
  } catch (err) {
    showStorageError("Could not delete the data. Please try again.");
  }
};

/* ===== Install prompt and service worker ===== */
let deferredPrompt;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $("#installBtn").classList.remove("hidden");
});
$("#installBtn").onclick = async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt = null;
  }
};
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

/* ===== Start ===== */
(async () => {
  try {
    await openDB();
    entries = await allEntries();
  } catch (err) {
    showStorageError("Your browser is blocking local storage, so check-ins cannot be saved. Try a normal (non-private) window and reload.");
  }
  renderHome();
})();
