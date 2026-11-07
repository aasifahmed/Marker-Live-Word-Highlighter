# Marker – Live Word Highlighter (v2)

Install
1. Open chrome://extensions
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
   (updating from an older version? Delete the old folder's contents first, copy these files in, then click the reload icon on the extension card)
4. Pin Marker from the puzzle-piece menu

Requires Chrome 119 or newer.

How it highlights
Marker paints highlights with the CSS Custom Highlight API. It never inserts, wraps or replaces anything in the page,
so sites that stream or re-render text (AI chat apps, React/Vue/Lexical/ProseMirror UIs) keep working normally.

Use
- Create sets ("Names", "Deadlines", "Warnings"...), each with its own color.
- Click a set's color swatch to open the picker: presets, hue/saturation/lightness sliders, or a hex code.
- Add words with commas or one per line; toggle a set on/off without deleting it.

Make it work everywhere (Chrome settings the extension cannot change itself)
- Incognito / private windows: chrome://extensions > Marker > Details > turn on **Allow in Incognito**
- Local files (file:///...): same Details page > turn on **Allow access to file URLs**
- Site access: Details > **Site access** must be "On all sites" (not "On click")
- Never possible: chrome:// pages, the Chrome Web Store, and the built-in PDF viewer
