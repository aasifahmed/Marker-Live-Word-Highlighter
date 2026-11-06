const MAX_WORDS = 100;
const MAX_SETS = 12;
const PRESETS = ["#fde047", "#86efac", "#93c5fd", "#f9a8d4", "#fdba74", "#c4b5fd", "#5eead4", "#fca5a5"];
const DEFAULTS = { enabled: true, caseSensitive: false, wholeWord: true, groups: [], words: [] };
const HEX = /^#[0-9a-f]{6}$/i;

let state = { ...DEFAULTS };
let flash = null; // { id, msg } – a short note to show on a card after re-render

const $ = (id) => document.getElementById(id);
const els = {
  enabled: $("enabled"),
  wholeWord: $("wholeWord"),
  caseSensitive: $("caseSensitive"),
  sets: $("sets"),
  newSet: $("newSet"),
  total: $("wordTotal"),
  status: $("status"),
  dot: $("statusDot")
};

/* ---------- Color helpers ---------- */

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function fgFor(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#14142b" : "#ffffff";
}

function hexToHsl(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

/* ---------- Storage ---------- */

let saveTimer = null;
let dirty = false;

function queueSave(delay = 300) {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, delay);
}

function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty) return;
  dirty = false;
  chrome.storage.sync.set({ groups: state.groups });
}

window.addEventListener("pagehide", flushSave); // don't lose edits when the popup closes

/* ---------- Data helpers ---------- */

const uid = () => Math.random().toString(36).slice(2, 9);
const totalWords = () => state.groups.reduce((n, g) => n + g.words.length, 0);

function normalizeGroup(g, i) {
  return {
    id: g.id || uid(),
    name: typeof g.name === "string" && g.name ? g.name : `Set ${i + 1}`,
    color: HEX.test(g.color) ? g.color.toLowerCase() : PRESETS[i % PRESETS.length],
    enabled: g.enabled !== false,
    words: Array.isArray(g.words) ? g.words.map(String) : []
  };
}

function newGroup() {
  const used = new Set(state.groups.map((g) => g.color));
  const color = PRESETS.find((c) => !used.has(c)) || PRESETS[state.groups.length % PRESETS.length];
  return normalizeGroup({ color }, state.groups.length);
}

// Older versions stored a flat list of {text, color}; turn it into sets.
function groupsFromLegacy(words) {
  const byColor = new Map();
  (words || []).forEach((w) => {
    if (!w || !w.text) return;
    const c = HEX.test(w.color) ? w.color : PRESETS[0];
    if (!byColor.has(c)) byColor.set(c, []);
    byColor.get(c).push(w.text);
  });
  return [...byColor.entries()].map(([color, list], i) => normalizeGroup({ color, words: list }, i));
}

function addWordsTo(group, raw) {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const taken = new Map();
  state.groups.forEach((g) => g.words.forEach((w) => taken.set(w.toLowerCase(), g.name)));

  const added = [];
  let msg = "";
  for (const text of parts) {
    const key = text.toLowerCase();
    if (taken.has(key)) { msg = msg || `“${text}” is already in ${taken.get(key)}.`; continue; }
    if (totalWords() + added.length >= MAX_WORDS) { msg = msg || `Limit of ${MAX_WORDS} words reached.`; break; }
    taken.set(key, group.name);
    added.push(text);
  }
  group.words.push(...added);
  return msg;
}

/* ---------- Rendering ---------- */

function applyColorVars(card, hex) {
  card.style.setProperty("--c", hex);
  card.style.setProperty("--fg", fgFor(hex));
}

function buildCard(g) {
  const card = document.createElement("article");
  card.className = "set" + (g.enabled ? "" : " off");
  card.dataset.id = g.id;
  applyColorVars(card, g.color);

  /* Header: color button, name, on/off, delete */
  const head = document.createElement("div");
  head.className = "set-head";

  const swatchBtn = document.createElement("button");
  swatchBtn.type = "button";
  swatchBtn.className = "swatch-btn";
  swatchBtn.setAttribute("aria-label", `Change color for ${g.name}`);
  swatchBtn.setAttribute("aria-expanded", "false");

  const nameInput = document.createElement("input");
  nameInput.className = "set-name";
  nameInput.type = "text";
  nameInput.maxLength = 24;
  nameInput.value = g.name;
  nameInput.setAttribute("aria-label", "Set name");
  nameInput.addEventListener("input", () => {
    g.name = nameInput.value.trim() || "Untitled";
    queueSave();
  });

  const toggle = document.createElement("label");
  toggle.className = "switch small";
  toggle.title = "Turn this set on or off";
  toggle.innerHTML =
    '<input type="checkbox"><span class="track"><span class="thumb"></span></span>';
  const toggleInput = toggle.querySelector("input");
  toggleInput.checked = g.enabled;
  toggleInput.setAttribute("aria-label", "Set enabled");
  toggleInput.addEventListener("change", () => {
    g.enabled = toggleInput.checked;
    card.classList.toggle("off", !g.enabled);
    queueSave(0);
  });

  const del = document.createElement("button");
  del.type = "button";
  del.className = "del";
  del.textContent = "Delete";
  del.addEventListener("click", () => {
    if (del.dataset.armed !== "true") {
      del.dataset.armed = "true";
      del.textContent = "Sure?";
      setTimeout(() => { del.dataset.armed = "false"; del.textContent = "Delete"; }, 2500);
      return;
    }
    state.groups = state.groups.filter((x) => x.id !== g.id);
    queueSave(0);
    render();
  });

  head.append(swatchBtn, nameInput, toggle, del);

  /* Color picker panel */
  const picker = document.createElement("div");
  picker.className = "picker";
  picker.hidden = true;
  picker.innerHTML = `
    <div class="presets" role="radiogroup" aria-label="Preset colors"></div>
    <div class="sliders">
      <label><span>Hue</span><input type="range" class="r-h" min="0" max="360"></label>
      <label><span>Saturation</span><input type="range" class="r-s" min="0" max="100"></label>
      <label><span>Lightness</span><input type="range" class="r-l" min="0" max="100"></label>
    </div>
    <label class="hex-row"><span>Hex</span><input type="text" maxlength="7" spellcheck="false" autocomplete="off"></label>`;

  const presetsEl = picker.querySelector(".presets");
  const sH = picker.querySelector(".r-h");
  const sS = picker.querySelector(".r-s");
  const sL = picker.querySelector(".r-l");
  const hexInput = picker.querySelector(".hex-row input");

  function updateTracks() {
    picker.style.setProperty("--hue", sH.value);
    picker.style.setProperty("--sat", sS.value + "%");
  }

  function syncPicker(source) {
    if (source !== "slider") {
      const [h, s, l] = hexToHsl(g.color);
      sH.value = h; sS.value = s; sL.value = l;
    }
    updateTracks();
    if (source !== "hex") hexInput.value = g.color;
    presetsEl.querySelectorAll(".preset").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.color === g.color));
    });
  }

  function setColor(hex, source) {
    g.color = hex.toLowerCase();
    applyColorVars(card, g.color);
    syncPicker(source);
    queueSave();
  }

  PRESETS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "preset";
    b.dataset.color = c;
    b.style.setProperty("--p", c);
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", `Use color ${c}`);
    b.addEventListener("click", () => setColor(c, "preset"));
    presetsEl.appendChild(b);
  });

  [sH, sS, sL].forEach((s) =>
    s.addEventListener("input", () => setColor(hslToHex(+sH.value, +sS.value, +sL.value), "slider"))
  );

  hexInput.addEventListener("input", () => {
    let v = hexInput.value.trim();
    if (/^[0-9a-f]{6}$/i.test(v)) v = "#" + v;
    if (HEX.test(v)) setColor(v, "hex");
  });
  hexInput.addEventListener("blur", () => { hexInput.value = g.color; });

  syncPicker("init");

  swatchBtn.addEventListener("click", () => {
    const opening = picker.hidden;
    els.sets.querySelectorAll(".picker").forEach((p) => { p.hidden = true; });
    els.sets.querySelectorAll(".swatch-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
    picker.hidden = !opening;
    swatchBtn.setAttribute("aria-expanded", String(opening));
  });

  /* Word chips */
  const chips = document.createElement("ul");
  chips.className = "chips";
  g.words.forEach((word, i) => {
    const li = document.createElement("li");
    li.className = "chip";

    const label = document.createElement("span");
    label.className = "word";
    label.textContent = word;

    const x = document.createElement("button");
    x.type = "button";
    x.className = "x";
    x.textContent = "×";
    x.setAttribute("aria-label", `Remove ${word}`);
    x.addEventListener("click", () => {
      g.words.splice(i, 1);
      queueSave(0);
      render({ id: g.id, sel: ".add-row input" });
    });

    li.append(label, x);
    chips.appendChild(li);
  });

  /* Add words */
  const addRow = document.createElement("div");
  addRow.className = "add-row";
  const addInput = document.createElement("input");
  addInput.type = "text";
  addInput.placeholder = "Add words, separated by commas";
  addInput.autocomplete = "off";
  addInput.spellcheck = false;
  addInput.setAttribute("aria-label", `Add words to ${g.name}`);
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "Add";

  const note = document.createElement("p");
  note.className = "note";
  note.setAttribute("role", "status");
  if (flash && flash.id === g.id) note.textContent = flash.msg;

  function commit() {
    if (!addInput.value.trim()) return;
    const msg = addWordsTo(g, addInput.value);
    queueSave(0);
    flash = msg ? { id: g.id, msg } : null;
    render({ id: g.id, sel: ".add-row input" });
  }
  addBtn.addEventListener("click", commit);
  addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); });

  addRow.append(addInput, addBtn);
  card.append(head, picker, chips, addRow, note);
  return card;
}

function render(focus) {
  els.sets.innerHTML = "";
  state.groups.forEach((g) => els.sets.appendChild(buildCard(g)));
  flash = null;

  els.total.textContent = `${totalWords()} / ${MAX_WORDS} words`;
  els.newSet.disabled = state.groups.length >= MAX_SETS;
  els.enabled.checked = state.enabled;
  els.wholeWord.checked = state.wholeWord;
  els.caseSensitive.checked = state.caseSensitive;

  if (focus) {
    const el = els.sets.querySelector(`[data-id="${focus.id}"] ${focus.sel}`);
    if (el) { el.focus(); if (focus.select) el.select(); }
  }
}

/* ---------- Global controls ---------- */

els.newSet.addEventListener("click", () => {
  if (state.groups.length >= MAX_SETS) return;
  const g = newGroup();
  state.groups.push(g);
  queueSave(0);
  render({ id: g.id, sel: ".set-name", select: true });
});

els.enabled.addEventListener("change", () => {
  state.enabled = els.enabled.checked;
  chrome.storage.sync.set({ enabled: state.enabled });
});
els.wholeWord.addEventListener("change", () => {
  state.wholeWord = els.wholeWord.checked;
  chrome.storage.sync.set({ wholeWord: state.wholeWord });
});
els.caseSensitive.addEventListener("change", () => {
  state.caseSensitive = els.caseSensitive.checked;
  chrome.storage.sync.set({ caseSensitive: state.caseSensitive });
});

/* ---------- Live count for the current tab ---------- */

async function updateStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await chrome.tabs.sendMessage(tab.id, { type: "mk-count" }, { frameId: 0 });
    const n = res.count;
    els.dot.classList.toggle("live", state.enabled);
    els.status.textContent = !state.enabled
      ? "Highlighting is off"
      : res.capped
        ? `${n} highlights shown (limit reached to keep the page fast)`
        : n === 0
          ? "No matches on this page yet"
          : `${n} highlight${n === 1 ? "" : "s"} on this page`;
  } catch {
    els.dot.classList.remove("live");
    els.status.textContent = "Not available on this page. Try a regular website.";
  }
}

/* ---------- Init ---------- */

chrome.storage.sync.get(DEFAULTS).then(async (stored) => {
  state = { ...DEFAULTS, ...stored };
  state.groups = (state.groups || []).map(normalizeGroup);

  if (!state.groups.length) {
    // First run with sets: migrate old flat word list, or start with one empty set.
    state.groups = groupsFromLegacy(state.words);
    if (!state.groups.length) state.groups = [newGroup()];
    await chrome.storage.sync.set({ groups: state.groups });
    await chrome.storage.sync.remove("words");
  }

  render();
  updateStatus();
  setInterval(updateStatus, 1000);
});
