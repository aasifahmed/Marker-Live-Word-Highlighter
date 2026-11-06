(() => {
  const MARK_CLASS = "mk-hl";
  const SKIP_SELECTOR = [
    "script", "style", "noscript", "textarea", "input", "select", "option",
    "canvas", "svg", "iframe", `.${MARK_CLASS}`,
    '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]'
  ].join(",");

  const DEFAULTS = { enabled: true, caseSensitive: false, wholeWord: true, groups: [], words: [] };
  const OBSERVER_OPTIONS = { childList: true, subtree: true, characterData: true };
  const FALLBACK_COLOR = "#fde047";
  const HEX = /^#[0-9a-f]{6}$/i;

  /* ---- Performance guards ---- */
  const MAX_MARKS = 3000;          // hard cap on highlights per page
  const SLICE_MS = 8;              // max main-thread time per work slice
  const DEBOUNCE_MS = 120;         // coalesce bursts of page mutations
  const ROOT_COLLAPSE_LIMIT = 500; // too many changed roots -> one walk of <body>
  const APPLY_DEBOUNCE_MS = 150;   // coalesce rapid settings changes

  let settings = { ...DEFAULTS };
  let regex = null;
  let colorMap = new Map();        // normalized word -> { bg, fg }
  let appliedEnabled = true;

  let markCount = 0;
  let capped = false;

  let jobs = [];
  let singles = [];
  const pendingRoots = new Set();

  let debounceTimer = null;
  let applyTimer = null;
  let slice = null;

  /* ---------- Colors ---------- */

  function fgFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? "#14142b" : "#ffffff";
  }

  function norm(text) {
    return (settings.caseSensitive ? text : text.toLowerCase()).replace(/\s+/g, " ");
  }

  /* ---------- Sets -> regex ---------- */

  // Older versions stored a flat list of {text, color}; group it by color.
  function legacyGroups(words) {
    const byColor = new Map();
    (words || []).forEach((w) => {
      if (!w || !w.text) return;
      const c = HEX.test(w.color) ? w.color : FALLBACK_COLOR;
      if (!byColor.has(c)) byColor.set(c, { color: c, enabled: true, words: [] });
      byColor.get(c).words.push(w.text);
    });
    return [...byColor.values()];
  }

  function getGroups() {
    return settings.groups && settings.groups.length ? settings.groups : legacyGroups(settings.words);
  }

  function build() {
    const map = new Map();
    const list = [];

    for (const g of getGroups()) {
      if (!g || g.enabled === false) continue;
      const bg = HEX.test(g.color) ? g.color : FALLBACK_COLOR;
      const style = { bg, fg: fgFor(bg) };
      for (const raw of g.words || []) {
        const t = String(raw).trim();
        if (!t) continue;
        const key = norm(t);
        if (map.has(key)) continue; // first set wins if a word appears twice
        map.set(key, style);
        list.push(t);
      }
    }
    if (!list.length) return { re: null, map };

    const escaped = list
      .sort((a, b) => b.length - a.length) // longest first: "New York" beats "New"
      .map((t) => t.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&").replace(/\s+/g, "\\s+"));

    const body = `(?:${escaped.join("|")})`;
    const pattern = settings.wholeWord
      ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`
      : body;

    try {
      return { re: new RegExp(pattern, settings.caseSensitive ? "gu" : "giu"), map };
    } catch (e) {
      console.warn("[Marker] Could not build pattern:", e);
      return { re: null, map };
    }
  }

  /* ---------- Highlighting a single text node ---------- */

  function isSkippable(textNode) {
    const el = textNode.parentElement;
    return !el || !!el.closest(SKIP_SELECTOR);
  }

  function styleMark(mark, style) {
    mark.style.setProperty("background-color", style.bg, "important");
    mark.style.setProperty("color", style.fg, "important");
  }

  function highlightTextNode(node) {
    if (!node.isConnected || isSkippable(node)) return;
    const text = node.nodeValue;
    if (!text || !/\S/.test(text)) return;

    regex.lastIndex = 0;
    let match, last = 0, frag = null;

    while ((match = regex.exec(text))) {
      if (match[0].length === 0) { regex.lastIndex++; continue; }
      if (markCount >= MAX_MARKS) { capped = true; break; }

      frag = frag || document.createDocumentFragment();
      if (match.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      }

      const raw = match[0];
      const mark = document.createElement("mark");
      mark.className = MARK_CLASS;
      styleMark(mark, colorMap.get(norm(raw)) || { bg: FALLBACK_COLOR, fg: "#14142b" });
      mark.textContent = raw;
      frag.appendChild(mark);
      markCount++;

      last = match.index + raw.length;
    }

    if (frag) {
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  /* Colors changed but the words didn't: just repaint existing marks. */
  function recolor() {
    document.querySelectorAll(`mark.${MARK_CLASS}`).forEach((mark) => {
      styleMark(mark, colorMap.get(norm(mark.textContent)) || { bg: FALLBACK_COLOR, fg: "#14142b" });
    });
  }

  /* ---------- Incremental work scheduler ---------- */

  function addWalkJob(root) {
    if (root.nodeType === Node.ELEMENT_NODE && root.closest(SKIP_SELECTOR)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
    });
    jobs.push({ root, walker, next: walker.nextNode() });
  }

  function hasWork() {
    return singles.length > 0 || jobs.length > 0;
  }

  function scheduleSlice() {
    if (slice) return;
    if (typeof requestIdleCallback === "function") {
      slice = { idle: true, id: requestIdleCallback(runSlice, { timeout: 400 }) };
    } else {
      slice = { idle: false, id: setTimeout(() => runSlice(null), 16) };
    }
  }

  function cancelSlice() {
    if (!slice) return;
    if (slice.idle) cancelIdleCallback(slice.id); else clearTimeout(slice.id);
    slice = null;
  }

  function dropWork() {
    jobs = [];
    singles = [];
    pendingRoots.clear();
    clearTimeout(debounceTimer);
    debounceTimer = null;
    cancelSlice();
  }

  function runSlice(deadline) {
    slice = null;
    if (!settings.enabled || !regex) { dropWork(); return; }
    if (document.hidden) return; // resumes on visibilitychange

    const idleBudget = deadline && !deadline.didTimeout ? deadline.timeRemaining() : SLICE_MS;
    const budget = Math.max(4, Math.min(idleBudget, 12));
    const start = performance.now();

    observer.disconnect(); // don't react to our own DOM edits
    let steps = 0;

    while (!capped && hasWork()) {
      if ((++steps & 15) === 0 && performance.now() - start > budget) break;

      let node;
      if (singles.length) {
        node = singles.pop();
      } else {
        const job = jobs[0];
        node = job.next;
        if (!node || !job.root.isConnected) { jobs.shift(); continue; }
        job.next = job.walker.nextNode(); // advance BEFORE replacing the current node
      }
      highlightTextNode(node);
    }

    observer.takeRecords();

    if (capped) { dropWork(); return; }

    observer.observe(document.documentElement, OBSERVER_OPTIONS);
    if (hasWork()) scheduleSlice();
  }

  /* ---------- Watching the page ---------- */

  function flushPending() {
    debounceTimer = null;
    if (!settings.enabled || !regex || capped) { pendingRoots.clear(); return; }

    if (pendingRoots.size > ROOT_COLLAPSE_LIMIT) {
      pendingRoots.clear();
      if (document.body) addWalkJob(document.body);
    } else {
      pendingRoots.forEach((node) => {
        if (!node.isConnected) return;
        if (node.nodeType === Node.TEXT_NODE) singles.push(node);
        else if (node.nodeType === Node.ELEMENT_NODE) addWalkJob(node);
      });
      pendingRoots.clear();
    }
    if (hasWork()) scheduleSlice();
  }

  const observer = new MutationObserver((mutations) => {
    if (!settings.enabled || !regex || capped) return;

    for (const m of mutations) {
      if (m.type === "childList") {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === Node.ELEMENT_NODE && n.classList.contains(MARK_CLASS)) return;
          if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE) pendingRoots.add(n);
        });
      } else if (m.type === "characterData") {
        const parent = m.target.parentElement;
        if (parent && !parent.closest(`.${MARK_CLASS}`)) pendingRoots.add(m.target);
      }
    }

    if (pendingRoots.size && !debounceTimer) {
      debounceTimer = setTimeout(flushPending, DEBOUNCE_MS);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && hasWork()) scheduleSlice();
  });

  /* ---------- Apply / clear ---------- */

  function clearAll() {
    observer.disconnect();
    dropWork();
    markCount = 0;
    capped = false;

    const parents = new Set();
    document.querySelectorAll(`mark.${MARK_CLASS}`).forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parents.add(parent);
    });
    parents.forEach((p) => p.normalize());
  }

  function apply() {
    clearAll();
    const built = build();
    regex = built.re;
    colorMap = built.map;
    appliedEnabled = settings.enabled;
    if (!settings.enabled || !regex || !document.body) return;
    addWalkJob(document.body);
    observer.observe(document.documentElement, OBSERVER_OPTIONS);
    scheduleSlice();
  }

  /* Re-highlight only when the words/options changed; a pure color change is a cheap repaint. */
  function refresh() {
    const built = build();
    const unchanged =
      regex && built.re && settings.enabled === appliedEnabled &&
      built.re.source === regex.source && built.re.flags === regex.flags;

    if (unchanged) {
      colorMap = built.map;
      recolor();
    } else {
      apply();
    }
  }

  function scheduleRefresh() {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(refresh, APPLY_DEBOUNCE_MS);
  }

  /* ---------- Settings + popup messages ---------- */

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    apply();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const key in changes) settings[key] = changes[key].newValue;
    scheduleRefresh();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "mk-count") {
      sendResponse({
        count: document.querySelectorAll(`mark.${MARK_CLASS}`).length,
        capped
      });
    }
  });
})();
