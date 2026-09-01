# Brand assets — MAKAM Home Stays

## Drop the artwork here

Save the files into this directory. **No code change is needed** — the app detects what is
present on the next request and uses it.

| File | Required? | Used for |
|---|---|---|
| `makam-logo.png` | master, if supplied | sidebar header, sign-in, print |
| `makam-logo.svg` | **DELIVERED** | same, but crisp at any size — tried first |
| `makam-mark.svg` | **still needed** | collapsed sidebar, mobile bar, favicon, avatar |
| `makam-mark.png` | optional fallback | used only if the SVG mark is absent |
| `og-image.png` (1200×630) | optional | link previews |

The **mark** is the badge **without** the wordmark. It is a separate file because
the full badge is illegible below about 48 px, which is exactly the size the collapsed
sidebar and the favicon need.

## How the app uses them

- **Vector first.** `makam-logo.svg` is tried before the PNG; the mark likewise.
- **Dimensions are read from the file** — the PNG header, or the SVG `viewBox`. Nothing is
  hard-coded, so whatever proportions you supply are the proportions rendered.
- **Height is pinned, width is never set.** The file's own aspect ratio always wins, so no
  layout change can stretch the logo.
- **A file that cannot be measured is treated as absent.** Rendering artwork of unknown
  proportions is how logos get squashed, so it falls back instead.
- **Absence is a normal state.** Until the files land, the shell shows a typographic
  lockup — the wordmark as text plus a neutral placeholder mark built from the palette in
  `lib/shared/brand.ts`. It is a stand-in, **not** a reconstruction of your badge; the app
  never redraws the logo.
- **Failure degrades in steps.** If the full lockup fails to load in the browser: mark plus
  wordmark text. If that fails too: placeholder mark plus wordmark text. The brand stays
  legible at every stage.
- **The favicon is declared only when the mark exists**, so an undelivered asset does not
  produce a 404 on every page load.

In development the directory is re-read on each request, so you can drop a file in and
refresh. In production it is resolved once at startup — redeploy after changing artwork.

## Usage rules

- **Clear space:** at least 25% of the badge diameter on all sides.
- **Minimum size:** 120 px for the full badge; below that use `makam-mark.svg`.
- **Background:** the cream `--brand-cream`. On photography, place it on a solid cream
  disc — never straight onto an image.
- **Do not** recolour, stretch, rotate, add effects, or reset the wordmark in another
  typeface.
- **Dark UI:** supply a cream-on-green inverse lockup if one exists; do not invert the
  artwork algorithmically.

## Verifying after you drop the files

```bash
npx vitest run tests/brand.test.tsx
```

The suite measures whatever is actually on disk. With the real artwork present it checks
that artwork — so delivering the logo strengthens the tests rather than bypassing them.

## What has been delivered (and what is still missing)

**`makam-logo.svg` — delivered.** An SVG wrapping a 2048x682 RGBA PNG: the MAKAM
wordmark in fine bronze capitals (#92632B), transparent background, so it sits on the
cream shell and the dark theme alike. It is installed byte-for-byte as supplied.

Worth knowing, because it governs how large the brand reads: the letterforms occupy only
the middle **29%** of the file's height (about 35% transparent padding above and below,
and ~8% each side). At the shell's 40px lockup height that puts roughly **12px** of
actual ink on screen. Nothing is distorted or clipped — the box always matches the file's
own 3.0029 ratio — but if the brand should read larger, the two levers are a
tighter-cropped export (much the better one) or `BRAND_ASSET_SPECS.logo.renderHeight`,
which has headroom to about 47px before the mobile drawer's brand row starts to squeeze
it.

**`makam-mark.svg` — NOT supplied.** The artwork is a wordmark only: there is no badge,
monogram or symbol in it, and none was invented. Until a real mark arrives:

- the collapsed rail and the mobile bar show the neutral placeholder glyph, labelled with
  the product name — the full 3:1 lockup cannot be used there, since at 64px it would be
  squeezed to an unreadable sliver;
- **no favicon is declared at all** (the metadata only emits one when the mark exists, so
  there is no 404 on every page load) — the browser tab falls back to its default icon.

A square, single-colour mark that works down to 16px is what unlocks both.
