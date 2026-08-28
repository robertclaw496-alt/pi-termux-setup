---
name: html-artifacts
description: Creates self-contained, mobile-friendly HTML artifacts for plans, status reports, code reviews, diagrams, research explainers, slide decks, and small interactive editors. Use when the user explicitly asks for HTML, a visual/interactive artifact, a browser-friendly report, or a presentation instead of plain Markdown.
---

# HTML Artifacts

Create an HTML file only when the user explicitly asks for it, or asks for a visual, browser-friendly, interactive, presentation-style, or printable artifact. Do not replace ordinary concise terminal answers with HTML by default.

## Output location

- Save finished deliverables in `/sdcard/Download/`.
- Use a descriptive kebab-case filename, for example:
  - `implementation-plan-auth-refresh.html`
  - `server-status-2026-07-27.html`
  - `code-review-payment-flow.html`
- State the exact saved path in the final response.
- Never overwrite an existing artifact unless the user asks to update it. Add a date or numeric suffix instead.

## Required quality bar

Every artifact must be a single, standalone `.html` file:

- Include `<!doctype html>`, UTF-8 charset, viewport meta tag, descriptive `<title>`, and semantic landmark elements where appropriate.
- Put all CSS, JavaScript, SVG, icons, and data inline. Do not use build tools, frameworks, CDNs, remote fonts, images, iframes, fetch requests, analytics, or external scripts.
- Design mobile-first: readable at roughly 360 px width, with tables/cards that do not force horizontal scrolling where a card layout is possible.
- Use system font stacks; provide sufficient contrast; do not communicate meaning by color alone.
- Keep the content skimmable: concise heading, TL;DR/status block, clear section hierarchy, whitespace, and visual grouping.
- Include only claims supported by the task context. Mark unknowns, assumptions, sample data, and estimates explicitly.
- Use natural language matching the user’s language, normally Russian.

## Safety and privacy

- Treat generated HTML as a local document, not a trusted application.
- Never embed secrets, API keys, tokens, passwords, private URLs with credentials, or personally sensitive data.
- Do not use `eval`, `Function`, inline event-handler attributes (`onclick`, etc.), or dynamic insertion of untrusted strings through `innerHTML`.
- For interaction, attach event listeners in a script and use `textContent` for dynamic user-provided content.
- Do not create a form that sends data over the network. Any export or copy action must remain local.
- Mention if a user should inspect an artifact before sharing it when it contains operational or private data.

## Choose the artifact shape

Use the smallest format that improves understanding:

| Request type | Useful structure |
|---|---|
| Implementation or migration plan | summary cards, milestones, dependency/data-flow SVG, risk matrix, open questions |
| Status / incident report | current status, timeline, metrics, impact, decisions, follow-up checklist |
| Code review / architecture | change summary, annotated findings, severity tags, module map, review checklist |
| Research / explanation | TL;DR, progressive disclosure via `<details>`, comparison table, glossary, diagram |
| Comparison / exploration | side-by-side option cards, constraints, trade-offs, recommendation |
| Presentation | one `<section>` per slide plus local keyboard navigation and visible controls |
| Small decision/editor UI | clearly bounded controls, local state only, reset button, copy/export of a Markdown or JSON result |

Avoid decorative charts and interaction. Use them only when they reveal relationships, trade-offs, progress, or state better than plain text.

## Implementation guidelines

1. First establish the audience, decision, and source data from the user request. Ask a concise clarifying question if essential facts are missing; otherwise clearly label assumptions.
2. Draft a compact information hierarchy before writing markup.
3. Use CSS custom properties for the palette, spacing, radii, and typography. Respect `prefers-reduced-motion` for animations.
4. Use inline SVG for flow diagrams; label arrows and ensure there is a text alternative or a short prose explanation nearby.
5. Make dense data responsive:
   - keep short tables only when legible on a phone;
   - otherwise render repeated cards or stacked definition lists.
6. Interactive controls must work with keyboard and have visible labels. Buttons need `type="button"`.
7. If adding “Copy” or “Export”, make it local via Clipboard API with a safe fallback; report success in an `aria-live` element.
8. Before completing, validate basic structure locally when practical:
   ```bash
   test -s /sdcard/Download/<file>.html
   rg -n 'https?://|<script[^>]+src=|<iframe|\beval\s*\(|\bFunction\s*\(' /sdcard/Download/<file>.html
   ```
   The search should return no operational external dependencies. `https://` only inside explanatory visible text is acceptable.
9. Open/read the generated file after writing it and correct clear structural defects. Do not launch a browser or Android Intent unless the user specifically asks.

## Final response

Keep it brief. State:

- what kind of artifact was created;
- its exact path in `/sdcard/Download/`;
- the key interactions, if any;
- an appropriate privacy reminder if it contains sensitive operational material.
