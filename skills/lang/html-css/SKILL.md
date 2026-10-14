---
name: html-css
description: Company standard for HTML and CSS - semantic markup, accessibility (WCAG 2.2 AA), responsive layout with flex/grid, design tokens and CSS custom properties, dark mode, forms, images and performance (Core Web Vitals), security headers and CSP, safe DOM manipulation, and linting with HTMLHint/Stylelint. Use when writing or reviewing HTML templates, CSS, static pages or front-end markup.
---

# HTML and CSS

Load `engineering-guardrails`, `secure-coding` and `code-fundamentals` first.

## 1. Markup

- Semantic elements: `header`, `nav`, `main` (one per page), `article`, `section` (with a heading), `aside`, `footer`, `button` for actions, `a` for navigation. No `div` with click handlers.
- Every page: `<!doctype html>`, `<html lang="en">`, `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">`, a unique `<title>`.
- One `h1`; headings in order without skipping levels.
- Images: meaningful `alt` (empty `alt=""` for decorative), explicit `width`/`height` to prevent layout shift, `loading="lazy"` below the fold, modern formats (`AVIF`/`WebP`) with `<picture>` fallback, `srcset`/`sizes` for responsive images.
- Links that open new tabs: `rel="noopener noreferrer"`.

## 2. Accessibility (WCAG 2.2 AA)

- Labels for every input (`<label for>`), grouped controls in `fieldset`/`legend`, errors linked with `aria-describedby` and announced (`aria-live="polite"`).
- Keyboard: everything operable by keyboard, visible focus (`:focus-visible` outline, never `outline: none` without replacement), logical tab order, no keyboard traps; skip link to `main`.
- Colour contrast ≥ 4.5:1 for text (3:1 large text and UI components); never colour alone to convey meaning.
- Target size ≥ 24×24 CSS px (WCAG 2.2).
- ARIA only when native HTML cannot express it ("no ARIA is better than bad ARIA").
- Respect `prefers-reduced-motion`.
- Test: axe DevTools / `@axe-core/cli`, Lighthouse accessibility, keyboard-only pass, a screen reader smoke test.

## 3. CSS

- Tokens as custom properties on `:root` (colour, spacing, radius, type scale); components use tokens, not literals.
- Dark mode via tokens redefined under `@media (prefers-color-scheme: dark)` (and a `[data-theme]` override if the app has a toggle).
- Layout with flexbox/grid and `gap`; mobile-first media queries or container queries; relative units (`rem`, `%`, `clamp()`).
- Avoid `!important` and deep selectors; keep specificity low (`.card__title`, utility classes, or CSS modules).
- `box-sizing: border-box` globally; no fixed widths that break at 360 px.
- Logical properties (`margin-inline`, `padding-block`) for RTL readiness.
- Lint: `stylelint` with `stylelint-config-standard`; format with Prettier.

## 4. Performance (Core Web Vitals)

- LCP < 2.5 s: preload the hero image/font, `fetchpriority="high"` on the LCP image, server-side render critical content.
- CLS < 0.1: dimensions on images/embeds, reserve space for ads/banners, `font-display: swap` with size-adjusted fallbacks.
- INP < 200 ms: avoid long tasks, defer non-critical JS (`defer`, `type="module"`), minimal third-party scripts.
- Compress and cache static assets (immutable hashed filenames + long `Cache-Control`).

## 5. Security in the browser

- No inline event handlers (`onclick=`) or inline scripts when using CSP; use `addEventListener`.
- Insert text with `textContent`; if HTML is required, sanitize with DOMPurify. Never `innerHTML`/`insertAdjacentHTML`/`document.write` with untrusted data.
- Security headers (set by server/CDN):

```
Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Opener-Policy: same-origin
```
- Subresource Integrity (`integrity` + `crossorigin`) for third-party scripts pinned to a version.
- Forms: `autocomplete` attributes correctly set; never put secrets or tokens in hidden fields of cached pages or in URLs.

## 6. Checks

```bash
npx htmlhint "src/**/*.html"
npx stylelint "src/**/*.css"
npx @axe-core/cli http://localhost:3000 --exit
npx lighthouse http://localhost:3000 --only-categories=accessibility,performance --quiet --chrome-flags="--headless"
```

## Definition of done

Follow `code-fundamentals`. For markup and styles:

```bash
npx prettier --check . && npx stylelint "**/*.css" && npx html-validate "**/*.html"
npx playwright test --reporter=line            # includes @axe-core/playwright accessibility checks
```

- Interactive components get behaviour tests (Testing Library or Playwright): keyboard use, focus, error states, empty states.
- Forms show a clear message for every validation and network error; never fail silently.

## Never

- Use `innerHTML` with untrusted data, inline event handlers with CSP, or `outline: none` without a focus replacement.
- Ship images without dimensions or alt text decisions.
- Load third-party scripts without a pinned version and SRI, or add trackers without privacy approval.
- Weaken CSP (`unsafe-inline`, `unsafe-eval`, `*`) to make something work.
