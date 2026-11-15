# Project instructions

Read `docs/DESIGN_SYSTEM.md` before changing UI or adding components.

## Required icon policy

- Never use emoji or emoticons anywhere in this project's UI, copy, tooltips, guides, example shader comments, documentation, or generated output.
- Never substitute a Unicode pictogram, font glyph, or text face for an icon. Use inline SVG or the shared SVG masks in `css/icons.css` (`glyph-icon icon-*`). Reuse an existing SVG icon when its meaning fits.
- Keep icons on the shared 24-unit grid, with a consistent stroke and `currentColor`. Give icon-only controls an accessible name (`aria-label`) and an explanatory `title`. Decorative inline SVGs must have `aria-hidden="true"` and `focusable="false"`.
- Where SVG cannot be rendered, such as browser tab titles and plain-text code comments, use clear words rather than an icon substitute.
- Preserve mathematical notation, programming syntax, and key names as text; they are content, not decorative icons.
- Run `node tests/no-emoji-regression.js` and the relevant UI checks after changing icons or copy. Keep `SOURCE_SHA256_Runtime.txt` current with `npm run sha`.
