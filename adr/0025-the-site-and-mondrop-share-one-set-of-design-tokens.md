# ADR-0025: The site and Mondrop share one set of design tokens, and a test keeps them aligned

## Status
**Accepted** (10 November 2026): Michele's requirement «giallo e nero - Mondrop like (e devon andare insieme gli stili)». **Built and tested in phase P1** of the look and feel of the site (SoundReel 2.21.0, plan `2026-11-10-web-look-and-feel.md`) and **in production since 10 November, 10:50** (his OK: «Sì, deploy»).

## Date
2026-11-10

## Owners
Michele Mondora

## Related
- spec `2026-11-10-web-look-and-feel-rethink-design.md` (§3.2 L2, §3.3 L6)
- `ios/MondropKit/MondropPalette.swift` (the colours of the app as plain numbers, with their contrast tests), spec `2026-11-08-mondrop-home-spotify-design.md` (H9–H10: the yellow, dark everywhere)
- ADR-0020 (the Mondrop Home), ADR-0026 (the configuration of the site)

---

## 1. Context
The site is dark with a green accent and a column of 800–900 px; Mondrop is yellow on black and midnight blue. Michele asked for the site to look like the app and for the two to **stay** together: «devon andare insieme gli stili». Two sets of colours kept by hand drift apart the first time one is touched.

## 2. Decision
1. **One source of values.** The app's numbers live in `MondropPalette.swift` (already tested for contrast). The site has **`frontend/src/styles/tokens.css`**, a short list of custom properties (`--mp-accent`, `--mp-bg-top`, `--mp-bg-bottom`, `--mp-system-bg`, `--mp-system-bg-2`, `--mp-system-bg-3`, `--mp-secondary-opacity`, `--mp-pill-fill-opacity`, `--mp-card-fill-opacity`, `--mp-error`, `--mp-on-accent`) with the same values, and **every other colour of the site is made from them**: the variables the old styles use (`--bg-primary`, `--accent`, `--text-secondary`…) are defined **from** the tokens, never from a hex.
2. **A test fails the build when they differ.** A frontend test reads the Swift file, turns each `RGB(r, g, b)` into hex and compares it with the token of the same role; it also checks that the legacy variables point at tokens. Change a colour on one side and the test names the other side.
3. **Forms go with the colours:** pill buttons (fully rounded), cards with corners of 14–16 px, numerals of fixed width, the yellow as the only accent, white text on dark (secondary text at 72 %), black text on the yellow. The green stays only as the colour of «success», never as an accent.
4. **The user does not choose the colour.** The configuration of the site (ADR-0026) has no colour in it.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| Copy the numbers once and trust nobody to forget | The palette of the app already changed twice in a week («colori sbagliati», «A, si giallo»); the site would be the one left behind |
| Generate `tokens.css` from the Swift file at build time | A build step on a machine with no Swift (the Docker image) for twelve numbers; the test gives the same guarantee without it |
| Let the user choose a theme | Against «uno stile solo»; and the yellow does not read on white (contrast 1.4: ADR of the app) |
| Keep the green accent and only change the layout | Michele asked for yellow and black |

## 4. Consequences
- ✅ The site and the app look like one product, and stay so.
- ✅ A palette change is one edit in the Swift file plus one line in `tokens.css`; the test says if one is forgotten.
- ⚠️ The test reads a file outside `frontend/` (`../ios/…`): it runs in the repository, not in the image.
- ⚠️ Old styles with hard-coded colours (about 64 greens in the CSS) have to be moved onto the variables once; a test counts the hex of the old accent so none comes back.
