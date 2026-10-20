# Landing Page Verification

## Scope

Public React landing page and its illustrative menu. No live account creation, backend, payment collection, or restaurant order submission is claimed.

## Initial landing results

- TypeScript and production Vite build: passed.
- Five Playwright browser tests: passed.
- Arabic and English tested at 320, 390, 768, 1024, and 1440 pixels.
- No horizontal document overflow; hero actions and chapter controls remain within bounds.
- Direct QR/sample link, category filters, dish sizes, quantities, totals, and simulated confirmation: passed.
- Plan prices and selected-plan preview: passed (EGP 200/350/500 monthly).
- Mobile navigation, video pause/play, and reduced-motion behavior: passed.
- Automated WCAG AA checks on the landing and menu dialog: no violations found.
- Independent finish review: ship, no material fixes.
- Mechanical design detector: no findings.
- Image provenance: six rasters checked, none missing.

## Historical production-build Lighthouse (before current hero refinement)

Local compiled build, default mobile simulation:

- Performance: 75/100.
- Accessibility: 100/100.
- First contentful paint: 2.7 s.
- Largest contentful paint: 5.7 s.
- Total blocking time: 10 ms.
- Cumulative layout shift: 0.001.

Scores are a local diagnostic, not a production uptime or performance guarantee. The hero movie and photography carry a mobile-network cost; further media delivery optimization can improve slow-connection loading. Device tests were browser simulations, not physical-device tests.

## Delivery status

The application and compiled dist/ output are available locally. External source synchronization/publication was rejected by automatic approval review because authorization to upload project source and assets was not established. No source upload or deployment completed; explicit approval is required before retrying publication.

## npm, supplied-logo and hero-layout refinement — 2026-10-20

- Clean npm dependency installation with package-lock.json; direct dependency versions preserved. Superseded pnpm lockfile removed. npm is the documented package manager.
- Header and footer display the original supplied logo with CSS-only margin trimming, bounded responsive widths and no header overlap.
- Hero uses separate grid areas for text/actions and chapters. Real filmed video and existing pause/play, seek and reduced-motion behavior preserved.
- Browser checks cover Arabic and English at 320, 390, 768, 1024, 1366 and 1440px; desktop heights 768px and 900px. At 1366×768 the complete hero fits in the viewport.
- Current verification: npm ci, npm run build and all five Playwright tests passed; axe found no WCAG AA violations. Layout detector returned no findings.
- Fresh independent hero review was unavailable because the reviewer hit its usage limit. Final logo/layout inspection was performed locally against the supplied logo and desktop/mobile captures; no fresh independent verdict is claimed.
- Current hero captures: .impeccable/review/hero-1440-ar.png, hero-1440-en.png, hero-390-ar.png and hero-390-en.png at the project root.

Latest size refinement: desktop logo reduced from 186px to 150px (about 19%); tablet/mobile scale down proportionally. Hero cap increased from 680px to 800px with viewport-aware height, keeping the complete stage visible on a 1366×768 laptop. A taller 1440×900 capture verifies the larger hero.

## SVG conversion and taller hero — latest refinement

- Header/footer now serve a 22KB transparent SVG with two outlined paths; XML inspection confirms no embedded raster, text/font dependency or external reference. Original PNG retained as source.
- Logo widths: 148px desktop, 140px tablet, 128px mobile, 120px narrow.
- Hero increased by 56px at a 1440×900 viewport; mobile minimum increased from 650px to 700px. Desktop cap is now 900px. The stage may extend slightly below the first viewport as requested.
- Production build and all five browser tests passed. Arabic/English layout checks cover six widths; video controls and automated accessibility checks still pass. Final screenshots include a 1440×1000 view so the whole taller stage is visible.

## Balanced hero height — final size adjustment

The user requested a smaller stage after viewing the taller version. Desktop height is now capped at 760px, with viewport-aware spacing; mobile minimum is 660px. The SVG logo, text and video remain unchanged. Production build and responsive Arabic/English checks verify no horizontal overflow, actions above chapters, and desktop chapter controls within the first viewport. Current hero proof uses 1440×900 and 390×844 captures.

## User-reference hero revision

- Full viewport film under a transparent, absolute header; white/coral vector logo; right-hand Arabic headline and CTAs; chapters/caption/pause below. Existing page content and real video preserved.
- Initial playback starts in the menu chapter (3.45s); pause/play, chapter seeking, reduced motion, offscreen pausing and menu fallback still work.
- TypeScript/Vite production build and five Playwright tests passed after final spacing and typography changes.
- Both languages tested at 1586, 1440, 1366, 1024, 768, 390 and 320px. No horizontal overflow; header logo stays bounded; headline clears overlay navigation; actions and chapters stay separated; desktop stage fills the first viewport.
- Reference-sized captures: `.impeccable/review/hero-reference-ar.png` and `hero-reference-en.png` at 1586×992. Mobile captures: `hero-390-ar.png` and `hero-390-en.png`.
- Axe AA checks passed for the page and menu dialog. Manual source detector reported no findings. No new JavaScript dependency or animation library added.

Independent reference review: full-screen composition, header/logo, typography, actions and desktop controls matched the supplied hierarchy. The retained filmed environment was accepted as a media adaptation, not an exact recreation of the reference café. The reviewer required larger mobile chapter labels. Labels were increased to 11px at all mobile widths with a 48px minimum button height, and the obsolete English 8px rule was removed. The reviewer scored that fix resolved across the recaptured Arabic/English desktop/mobile evidence, with no visible regressions; disposition ship at fix scope. Final production build and two affected browser checks passed after correction.

## Food-truck closing section

The prior green CTA band now uses a generated food-truck campaign image with exterior QR, outdoor diners and a foreground Arabic order-ready phone with vibration marks. Existing closing copy, trial action, hero and footer behavior are preserved. Desktop text overlays the quiet right area; mobile stacks a 360px scene above copy.

- Production build and all five browser tests passed; final responsive confirmation passed in both languages at seven widths after preserving footer spacing.
- Closing-section captures: `.impeccable/review/closing-1440-ar.png`, `closing-1440-en.png`, `closing-390-ar.png`, `closing-390-en.png`.
- Scoped mechanical detector: no findings. Public image provenance: 11 rasters, none missing.
- Fresh independent closing-section review returned ship with no material fixes. It confirmed visibility of the truck, QR, foreground alert and static vibration marks, readable copy/CTA and mobile crops.
- Static campaign imagery illustrates the notification; actual vibration still depends on device/browser support as described elsewhere on the page.
