/*
 * Marker – highlights words WITHOUT touching the page's DOM.
 *
 * Earlier versions wrapped matches in <mark> elements, which replaces text nodes. Sites that stream or
 * re-render text (AI chat apps, React/Vue/Lexical/ProseMirror UIs) keep references to their own text
 * nodes, so replacing them made updates vanish and cut sentences short. This version paints highlights
 * through the CSS Custom Highlight API (Chrome 105+): the page's nodes are never modified.
 */
(() => {
  // Used only for single nodes (an added root, a changed text node).
  const SKIP_SELECTOR = [
    "script", "style", "noscript", "textarea", "input", "select", "option", "canvas", "svg",
    "iframe", "head", "template", "object", "embed", "video", "audio"
  ].join(",");

  // Used while walking: a match prunes the element's whole subtree in one step.
  const SKIP_TAGS = new Set(SKIP_SELECTOR.split(","));

  const DEFAULTS = { enabled: true, caseSensitive: false, wholeWord: true, groups: [], words: [] };
  const OBSERVER_OPTIONS = { childList: true, subtree: true, characterData: true };
  const FALLBACK_COLOR = "#fde047";
  const HEX = /^#[0-9a-f]{6}$/i;

  /* ---- Speed / safety knobs ---- */
  const MAX_RANGES = 10000;        // cap on highlighted matches per page
  const SLICE_MS = 12;             // work per background slice (yields early if you type or click)
  const SYNC_MS = 5;               // work done immediately when the page changes, before the next paint
  const ROOT_COLLAPSE_LIMIT = 500; // too many changed roots at once -> one walk of <body>
  const APPLY_DEBOUNCE_MS = 60;    // coalesce rapid settings changes
  const SWEEP_MS = 400;            // drop highlights of removed text this long after the page removes it

  let settings = { ...DEFAULTS };
  let regex = null;
  let minLen = 1;                  // shortest word: shorter text nodes can't match, skip them
  let colorMap = new Map();        // normalized word -> style { name, bg, fg }
  let styles = new Map();          // set index -> style
  let sig = "";                    // which word belongs to which set (detects non-color changes)
  let appliedEnabled = true;

  let capped = false;
  let jobs = [];                   // incremental tree walks
  let singles = [];                // individual text nodes
  const pendingRoots = new Set();
  const shadowRoots = new Set();   // open shadow roots we also scan and watch

  let applyTimer = null;
  let sweepTimer = null;
  let sliceQueued = false;

  /* ---------- Highlight bookkeeping ---------- */

  const highlights = new Map();    // highlight name -> Highlight
  let rangesByNode = new WeakMap(); // text node -> [[Highlight, Range], ...]
  let rangeCount = 0;
  let sheet = null;                // one constructed stylesheet holding every ::highlight() rule

  const FALLBACK_STYLE = { name: "mk-fallback", bg: FALLBACK_COLOR, fg: "#14142b" };

  function fgFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? "#14142b" : "#ffffff";
  }

  function norm(text) {
    return (settings.caseSensitive ? text : text.toLowerCase()).replace(/\s+/g, " ");
  }

  function getHighlight(name) {
    let h = highlights.get(name);
    if (!h) {
      h = new Highlight();
      highlights.set(name, h);
      CSS.highlights.set(name, h);
    }
    return h;
  }

  // A constructed stylesheet is not subject to the page's Content-Security-Policy, unlike an injected <style>.
  function adopt(root) {
    try {
      if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch (e) { /* frozen or detached root */ }
  }

  function writeSheet() {
    const rules = [...styles.values(), FALLBACK_STYLE].map(
      (s) => `::highlight(${s.name}){background-color:${s.bg};color:${s.fg};}`
    );
    sheet.replaceSync(rules.join("\n"));
  }

  function ensureSheet() {
    if (!sheet) sheet = new CSSStyleSheet();
    adopt(document); // also re-adopts if the page overwrote document.adoptedStyleSheets
  }

  function clearNode(node) {
    const list = rangesByNode.get(node);
    if (!list) return;
    for (const [h, r] of list) {
      if (h.has(r)) { h.delete(r); rangeCount--; }
    }
    rangesByNode.delete(node);
  }

  // Highlights of text the page removed or rewrote end up collapsed or detached: drop them.
  function sweep() {
    sweepTimer = null;
    highlights.forEach((h) => {
      const dead = [];
      for (const r of h) if (r.collapsed || !r.startContainer.isConnected) dead.push(r);
      dead.forEach((r) => { h.delete(r); rangeCount--; });
    });
  }

  function sweepSoon() {
    if (!sweepTimer) sweepTimer = setTimeout(sweep, SWEEP_MS);
  }

  function totalRanges() {
    let n = 0;
    highlights.forEach((h) => { n += h.size; });
    return n;
  }

  /* ---------- Word list -> compact regex (prefix tree keeps thousands of words fast) ---------- */

  const escChar = (ch) => (/\s/.test(ch) ? "\\s+" : ch.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"));

  function trieToPattern(words) {
    const root = { kids: new Map(), end: false };
    for (const w of words) {
      let node = root;
      for (const ch of w) {
        let next = node.kids.get(ch);
        if (!next) { next = { kids: new Map(), end: false }; node.kids.set(ch, next); }
        node = next;
      }
      node.end = true;
    }

    const emit = (node) => {
      const parts = [];
      node.kids.forEach((child, ch) => parts.push(escChar(ch) + emit(child)));
      if (!parts.length) return "";
      if (node.end) return parts.length === 1 ? `(?:${parts[0]})?` : `(?:${parts.join("|")})?`;
      return parts.length === 1 ? parts[0] : `(?:${parts.join("|")})`;
    };
    return emit(root);
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
    const setStyles = new Map();
    const list = [];
    const sigParts = [];
    let shortest = Infinity;

    getGroups().forEach((g, idx) => {
      if (!g) return;
      const bg = HEX.test(g.color) ? g.color : FALLBACK_COLOR;
      const style = { name: `mk-${idx}`, bg, fg: fgFor(bg) };
      setStyles.set(idx, style);
      if (g.enabled === false) return;

      for (const raw of g.words || []) {
        const t = String(raw).trim();
        if (!t) continue;
        const key = norm(t);
        if (map.has(key)) continue; // first set wins if a word appears twice
        map.set(key, style);
        list.push(key);
        sigParts.push(key + "\u0001" + idx);
        if (key.length < shortest) shortest = key.length;
      }
    });

    const out = { map, styles: setStyles, sig: sigParts.join("\u0002"), min: 1, re: null };
    if (!list.length) return out;

    const body = `(?:${trieToPattern(list)})`; // greedy, so "New York" still beats "New"
    const pattern = settings.wholeWord
      ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`
      : body;

    try {
      out.re = new RegExp(pattern, settings.caseSensitive ? "gu" : "giu");
      out.min = shortest;
    } catch (e) {
      console.warn("[Marker] Could not build pattern:", e);
    }
    return out;
  }

  /* ---------- Highlighting a single text node ---------- */

  function isSkippable(textNode) {
    const parent = textNode.parentNode;
    if (!parent) return true;
    if (parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return false; // directly inside a shadow root
    return parent.nodeType !== Node.ELEMENT_NODE || !!parent.closest(SKIP_SELECTOR);
  }

  // `check` is only needed for nodes that did not come from the pruning tree walk.
  function highlightTextNode(node, check) {
    clearNode(node); // idempotent: re-scanning a node first removes its previous highlights
    if (!node.isConnected || (check && isSkippable(node))) return;

    const text = node.nodeValue;
    if (!text || text.length < minLen) return;

    regex.lastIndex = 0;
    let match, list = null;

    while ((match = regex.exec(text))) {
      if (match[0].length === 0) { regex.lastIndex++; continue; }
      if (rangeCount >= MAX_RANGES) { capped = true; break; }

      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);

      const h = getHighlight((colorMap.get(norm(match[0])) || FALLBACK_STYLE).name);
      h.add(range);
      (list = list || []).push([h, range]);
      rangeCount++;
    }
    if (list) rangesByNode.set(node, list);
  }

  /* ---------- Walking the page ---------- */

  function registerShadow(sr) {
    if (shadowRoots.has(sr)) return;
    shadowRoots.add(sr);
    adopt(sr);
    observer.observe(sr, OBSERVER_OPTIONS);
    addWalkJob(sr);
  }

  function observeAll() {
    observer.observe(document.documentElement, OBSERVER_OPTIONS);
    shadowRoots.forEach((r) => {
      if (r.host && r.host.isConnected) observer.observe(r, OBSERVER_OPTIONS);
      else shadowRoots.delete(r);
    });
  }

  function skipElement(el) {
    return SKIP_TAGS.has(el.localName);
  }

  function addWalkJob(root) {
    if (root.nodeType === Node.ELEMENT_NODE) {
      if (root.closest(SKIP_SELECTOR)) return;
      if (root.shadowRoot) registerShadow(root.shadowRoot); // the root itself is never offered to the filter
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (n.shadowRoot) registerShadow(n.shadowRoot);   // walk open shadow trees too
          return skipElement(n) ? NodeFilter.FILTER_REJECT  // prune script/style/inputs/etc.
                                : NodeFilter.FILTER_SKIP;   // otherwise just descend
        }
        return /\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    jobs.push({ root, walker, next: walker.nextNode() });
  }

  function hasWork() {
    return singles.length > 0 || jobs.length > 0;
  }

  /* ---------- Scheduler: immediate for page changes, background slices for the rest ---------- */

  // A MessageChannel task runs on the very next turn (setTimeout/idle callbacks can wait much longer).
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    if (!sliceQueued) return;
    sliceQueued = false;
    work(SLICE_MS);
  };

  function scheduleSlice() {
    if (sliceQueued) return;
    sliceQueued = true;
    channel.port2.postMessage(0);
  }

  function dropWork() {
    jobs = [];
    singles = [];
    pendingRoots.clear();
    sliceQueued = false;
  }

  const inputPending = () => {
    try { return navigator.scheduling && navigator.scheduling.isInputPending && navigator.scheduling.isInputPending(); }
    catch (e) { return false; }
  };

  function drainPending() {
    if (!pendingRoots.size) return;
    if (pendingRoots.size > ROOT_COLLAPSE_LIMIT) {
      pendingRoots.clear();
      if (document.body) addWalkJob(document.body);
      return;
    }
    pendingRoots.forEach((node) => {
      if (!node.isConnected) return;
      if (node.nodeType === Node.TEXT_NODE) singles.push(node);
      else if (node.nodeType === Node.ELEMENT_NODE) addWalkJob(node);
    });
    pendingRoots.clear();
  }

  /* Does up to `budget` ms of work, stops early if the user is interacting, then yields. */
  function work(budget) {
    if (!settings.enabled || !regex) { dropWork(); return; }
    if (document.hidden) return; // resumes on visibilitychange

    ensureSheet();
    drainPending();
    const start = performance.now();
    let steps = 0;

    while (!capped && hasWork()) {
      if ((++steps & 31) === 0 && (performance.now() - start > budget || inputPending())) break;

      if (singles.length) {
        highlightTextNode(singles.pop(), true);
      } else {
        const job = jobs[0];
        const node = job.next;
        if (!node || !job.root.isConnected) { jobs.shift(); continue; }
        job.next = job.walker.nextNode();
        highlightTextNode(node, false);
      }
    }

    if (capped) { dropWork(); return; }
    if (hasWork()) scheduleSlice();
  }

  /* ---------- Watching the page ---------- */

  // We never modify the DOM, so every record here comes from the page itself.
  const observer = new MutationObserver((mutations) => {
    if (!settings.enabled || !regex) return;

    let removed = false;
    for (const m of mutations) {
      if (m.type === "childList") {
        if (m.removedNodes.length) removed = true;
        m.addedNodes.forEach((n) => {
          if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE) pendingRoots.add(n);
        });
      } else if (m.type === "characterData") {
        pendingRoots.add(m.target); // text changed: its old highlights are stale, re-scan it
      }
    }
    if (removed) sweepSoon();

    // Highlight new content right now, in the same turn the page changed, so it never paints un-highlighted.
    if (pendingRoots.size && !capped) work(SYNC_MS);
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && (hasWork() || pendingRoots.size)) scheduleSlice();
  });

  /* ---------- Apply / clear ---------- */

  function clearAll() {
    observer.disconnect();
    dropWork();
    highlights.forEach((h, name) => { h.clear(); CSS.highlights.delete(name); });
    highlights.clear();
    rangesByNode = new WeakMap();
    rangeCount = 0;
    capped = false;
    shadowRoots.clear(); // rediscovered on the next scan
    if (sheet) sheet.replaceSync("");
  }

  function apply() {
    clearAll();
    const built = build();
    regex = built.re;
    colorMap = built.map;
    styles = built.styles;
    sig = built.sig;
    minLen = built.min;
    appliedEnabled = settings.enabled;
    if (!settings.enabled || !regex) return;

    ensureSheet();
    writeSheet();
    addWalkJob(document.body || document.documentElement);
    observeAll();
    work(SLICE_MS); // highlight the first screenful immediately, the rest follows in slices
  }

  /* Re-scan only when the words/options changed; a pure color change just rewrites the stylesheet. */
  function refresh() {
    const built = build();
    const unchanged =
      regex && built.re && settings.enabled === appliedEnabled && built.sig === sig &&
      built.re.source === regex.source && built.re.flags === regex.flags;

    if (unchanged) {
      colorMap = built.map;
      styles = built.styles;
      writeSheet();
    } else {
      apply();
    }
  }

  function scheduleRefresh() {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(refresh, APPLY_DEBOUNCE_MS);
  }

  /* ---------- Settings + popup messages ---------- */

  function start(stored) {
    settings = { ...DEFAULTS, ...stored };
    apply();
  }

  chrome.storage.local.get(DEFAULTS, (stored) => {
    if ((stored.groups || []).length || (stored.words || []).length) return start(stored);
    // Older versions used chrome.storage.sync; the popup moves the data over when opened.
    chrome.storage.sync.get(DEFAULTS, (old) => start(old));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key in changes) settings[key] = changes[key].newValue;
    scheduleRefresh();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "mk-count") {
      sendResponse({ count: totalRanges(), capped });
    }
  });
})();
