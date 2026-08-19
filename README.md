# Blooma — Salon Booking Platform

A two-sided salon booking product: a customer-facing marketplace/booking app and an owner admin panel, both deployed as static HTML on Vercel with Supabase as the backend. Demo salon used throughout: **Willow & Co.** (Hamilton, NZ).

## Architecture

- **No build step.** Each surface is a single self-contained HTML file — inline `<style>`, inline `<script>`, no bundler, no framework. State is a plain JS object; `render()` re-stringifies the whole page into `innerHTML` on every change.
- **Supabase** ([project: "Willow Salon Booking"](https://jzyvnipzdgfjportrbpo.supabase.co)) handles auth, Postgres data, and storage (venue images). Reads mostly go through two RPC functions rather than direct table selects:
  - `get_marketplace_venues()` — public, returns every active venue with its services/stylists/reviews/bookings/blockouts as one big JSON blob. This is what the customer app fetches on load.
  - `admin_save_config(payload, expected_version)` — the only way the admin panel writes. Takes the whole in-memory config as JSON, upserts `app_config`, and fans out specific fields into `salons`, `categories`, `stylists`, `services`, `addons`, `promotions`. Uses `expected_version` as an optimistic-concurrency check.
- **Vercel** serves the static files. `vercel.json` rewrites `/venue/:slug` → `/?venue=:slug` etc. so pretty URLs still hit `index.html`.
- **Geocoding** uses Nominatim (OpenStreetMap) — free, no API key. Deliberately *not* Google Places, which needs billing enabled. Admin's "Verify address on map" button geocodes on demand (not live-as-you-type), shows a picker when a search returns multiple candidates instead of guessing, and saves immediately on a match rather than waiting for a separate "Save changes" click.

## Local development

No more zip-uploading to Vercel to preview changes:

- **Live preview:** `vercel dev` serves this folder at `http://localhost:3000` with the same `vercel.json` rewrites as production. Edit any HTML file and refresh — no build step.
- **Deploys:** this folder is a git repo pushed to [github.com/BigCav/Blooma](https://github.com/BigCav/Blooma), linked to the Vercel project `blooma-vercel-upload-v105-checkout-suburb-checklist` via GitHub integration. `git push` triggers a preview deploy; pushes to `main` go to production. Plain `vercel`/zip-based deploys before this were each creating a brand-new one-off Vercel project — that's why the account has many `blooma-project-xxxx` / `blooma-vercel-upload-vNN-*` projects; only the one above is now kept current via git.

## Files

| File | Purpose |
|---|---|
| `index.html` | Customer app — marketplace home, venue pages, booking flow, checkout, login/account |
| `salon-admin-v3-24-supabase.html` | Owner admin panel (routed at `/venue/admin`) |
| `salon-onboarding-supabase.html` | New-salon signup/onboarding flow |
| `customer-login-register-supabase.html` | Customer auth |
| `for-business/index.html` | Marketing landing page for prospective salon owners |
| `privacy-policy.html`, `terms-conditions.html`, `404.html` | Static legal/error pages |
| `blooma-confirmation-email-template.html` | Transactional email template |
| `vercel.json` | Routing/rewrites for the static deploy |

## Database notes (Supabase — `public` schema)

`salons` is the core table. Notable columns added during this project (beyond the original onboarding fields): `lat`, `lng`, `address_verified`, `suburb`, `postcode`. Two bugs worth remembering if this table's write path is touched again:

- `admin_save_config` originally never wrote `city`/`region` back to `salons` at all — editing City in Settings silently didn't persist. Fixed, but a reminder to check the RPC's `update ... set` list whenever a new Settings field is added, not just the JS payload.
- `get_marketplace_venues` has to be updated in lockstep any time a new `salons` column needs to reach the customer app — the customer app only ever sees what this function explicitly returns.

## Desktop responsive design — lessons learned the hard way

The apps were originally mobile-only; desktop (`≥1024px`) layouts were added on top. A few real bugs surfaced repeatedly and are worth not repeating:

1. **CSS cascade order, not just specificity, decides ties.** Several early desktop overrides were silently losing to earlier same-specificity rules defined later in the file. Fix/convention adopted: **all desktop overrides live in one `@media (min-width:1024px)` block at the very end of `<style>`**, so they always win regardless of what's defined above.
2. **Don't introduce a new element that has to "hand off" from an old one via conditional CSS** (e.g. `:has()` to hide element A only when element B is present). If that relationship fails for any reason, you can end up with *neither* showing. The working pattern instead: reuse the exact same DOM elements that already work on mobile, and just change their CSS layout (e.g. the desktop photo grid is the same `hero-carousel`/`hero-slide` elements from the mobile carousel, just placed into a CSS grid via `nth-child` at desktop width — not a competing new element).
3. **Grid columns that share a row move together.** "About" and "Ready to book" are two columns in the same grid row — anything that shifts the row's start (e.g. margin on an element above it) moves both. To let them be positioned independently, each column got its own explicit `margin-top` instead of relying on shared "row start" positioning.
4. When debugging "why isn't this showing," rule out **DevTools itself narrowing the viewport below the breakpoint** before assuming the code is broken — a docked panel can easily push a wide window under 1024px.
5. **A flex item with `margin: auto` on the cross axis won't stretch, even with `max-width` set.** The checkout card (`.checkout-shell`) sat inside a column-direction flex parent with `margin:32px auto` for centering — spec behavior is that cross-axis auto margins suppress the default stretch, so the card shrink-wrapped to ~340px instead of filling up to its `max-width:640px`. Fix: give it an explicit `width:100%` alongside `max-width` so sizing no longer resolves to `auto`.

## Feature highlights implemented in this project

- City picker (bottom-sheet, shared list between admin and customer) replacing free-text city/region entry.
- Address verification via Nominatim with multi-candidate disambiguation, suburb/postcode capture, and immediate save.
- Venue map links/embeds use the verified lat/lng with the address as a custom label (`q=lat,lng(label)`) rather than a text search, so they pin the exact building instead of Google's best guess.
- Desktop-specific layouts: 3-across marketplace grid, Fresha-style photo gallery (main + stacked thumbnails, alternating direction every group of 3, orphan-tile fallback), single-line venue header (stars, review count, open/closed with hours, suburb+city, "Get directions").
- Marketplace cards (`.featured-salon-card`) redesigned for a larger image, name, star rating + review count, "Suburb, City", and live open/closed status line beneath — same card markup reused at both breakpoints.
- Checkout flow (`.service-select-shell`, `.booking-checkout-shell`) is a proper two-column Fresha-style layout at desktop: service list / stylist / date-time / details / confirm steps on the left, a persistent sticky sidebar on the right (venue photo, rating, address, selected date/time, item + add-on breakdown, running total, Continue button). Implemented via CSS Grid named areas reusing the same DOM nodes as mobile — mobile keeps the original single-column flow untouched. The final "You're all set" confirmation screen also gets a wider desktop card (`.confirm-done-shell`, 760px vs the normal 640px).
- Date picker in the booking flow now offers 21 days ahead (was 7), with larger day-pills at desktop; the stylist profile's "Available this week" widget intentionally still shows only the first 7 of those.
- Manage → Venue "Publish checklist" — live-updating checklist (cover image, verified address, city, phone, about text, hours, ≥1 service) with a completion count.
- Venue category taxonomy standardized to: Hair & styling, Nails, Hair removal, Eyebrows & eyelashes, Facials & skincare, Massage, Makeup, Barbering, Spa & wellness, Body & skin — used for the onboarding category picker and the home page filter chips. This is distinct from admin's per-venue "Manage → Categories", which stays free-text since it's for organizing a venue's own service menu (not a fixed type). Willow & Co. and Corban Vietmeyer's `salons.tag` were updated to `Hair & styling` / `Nails` respectively to match; the other demo venues (Aura, Haze, Hello, Lumen, Marble, Pearl, Wip Co) still carry pre-taxonomy tags and would need the same treatment if they go live.

## Design tokens

All colors are CSS custom properties on `:root` (defined once per file — `index.html` and the admin file each declare their own copy, but they're kept identical):

```css
--ink:        #241F33   /* primary text */
--ink-soft:   #8A80AD   /* secondary/muted text */
--ink-mute:   #6B6285   /* body copy, slightly softer than ink */
--purple:     #7C5CD9   /* brand/accent — buttons, active states, links */
--purple-dark:#6D4DC7   /* hover state for --purple */
--purple-pastel:  #F1ECFB  /* tag pills, soft backgrounds */
--purple-pastel-2:#F3EEFC  /* card/icon backgrounds, image placeholders */
--border:     #EFECF9   /* default hairline border */
--border-2:   #E9E4F7   /* input/card border, slightly stronger */
--border-hover:#C9BBEF  /* border on hover/focus, separator dots */
--bg:         #FAF9FD   /* page background */
--white:      #FFFFFF
--placeholder:#B3ABCB   /* input placeholder text */
--disabled:   #DED4F5   /* disabled button background */
--gold:       #F5A623   /* star ratings only */
```
Status colors are used inline rather than as tokens: green `#1E8A4C` (open/success/verified), red `#C13B3B` (closed/error).

**Shape & spacing conventions:**
- Pills/buttons/chips: `border-radius:999px` (fully round)
- Cards/panels: `border-radius:14–20px` (16px and 20px are the most common)
- Small icon containers (`.venue-info-icon` etc.): `border-radius:10–11px`
- Body font: system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`) — no webfont loaded
- Base font sizes: 12–12.5px for labels/meta text, 14px for body/buttons, 19px for mobile page titles (30px at desktop)

**Recurring component classes** (defined once, reused everywhere — check before adding a new one-off style):
| Class | What it is |
|---|---|
| `.primary-btn` / `.secondary-btn` | Full-width pill buttons (filled purple / white-bordered) |
| `.chip` / `.chip-row` | Pill-shaped filter/category selectors, horizontal scroll row |
| `.tag-pill` | Small rounded label (service category, "NEW" badge, etc.) |
| `.field` / `.field-btn` | Settings form input wrapper / tappable field styled like an input (used for pickers) |
| `.manage-card` | White bordered card, admin Manage tab sections |
| `.status-pill` / `.status-dot` | Open/Closed indicator |
| `.venue-info-icon` | Small rounded-square icon chip (used in address/hours rows, city picker rows) |
| `.backbtn` / `.menu-btn` | Circular white icon buttons in the topbar |
| `.sep-dot` | Small circular bullet separator (desktop venue header line) |
| `.eyebrow` | Small uppercase section label (e.g. "ABOUT") |

## Known limitations / things to revisit

- Publish-checklist criteria were my best guess at "ready to go live," not something explicitly specified — worth confirming the exact required fields.
- Suburb/postcode only populate going forward from a re-verify; existing venues won't retroactively have them.
- Gallery grid's alternating-groups-of-3 layout has fallback rules for 1 or 2 leftover photos, but hasn't been visually confirmed on a venue with more than ~4 real photos.
- No build/lint/test tooling — every change is manual, hand-verified via `node --check` on the extracted inline `<script>` for syntax only (not runtime behavior). Visual/behavioral changes were checked with a headless Chrome + puppeteer-core script (not part of the repo) rather than any committed test suite.
- Other demo venues beyond Willow & Co. / Corban Vietmeyer (Aura, Haze, Hello, Lumen, Marble, Pearl, Wip Co) still have pre-taxonomy tags and aren't currently visible in the Hamilton listing; revisit if they're made active.
