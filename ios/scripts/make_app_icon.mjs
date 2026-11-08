#!/usr/bin/env node
/**
 * Mondrop's icons, drawn as vectors (spec docs/superpowers/specs/2026-11-08-mondrop-app-icon-design.md).
 *
 *   node ios/scripts/make_app_icon.mjs              # rewrites ios/icon/*.svg and the two icon catalogs
 *   node ios/scripts/make_app_icon.mjs --house DIR  # the house twin (Casamon TV, «home-ass») into DIR
 *
 * What it draws (Michele picked these on 8 November, «la goccia con le onde (sfondo giallo e goccia nera) per mondrop, mentre
 * la casa gialla con le onde a sfondo azzurro per home-ass»):
 *   - the app:   a black drop with an equalizer cut out of its belly, on yellow. iOS 18 also gets a dark version (yellow
 *                drop on midnight) and a tinted one (grey, the system colours it);
 *   - the share sheet (MondropShare): the same drop, with a down arrow instead of the equalizer («lascia qui»);
 *   - the twin:  a yellow house with the same equalizer, on blue. Not part of the app: it is the icon of the Casamon TV app.
 *
 * The art is plain SVG text built here, so every size is sharp and the design is reviewable as a diff. iOS gets one opaque
 * 1024 px PNG per appearance (App Store Connect refuses an alpha channel, and iOS applies its own mask); macOS gets the
 * rounded tile with a soft shadow in the ten standard sizes.
 *
 * Needs `sharp`, which the backend already ships: `cd backend && npm ci` once.
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const IOS_ROOT = path.resolve(HERE, '..');
export const ICON_DIR = path.join(IOS_ROOT, 'icon');
export const APP_CATALOG = path.join(IOS_ROOT, 'Mondrop/Assets.xcassets/AppIcon.appiconset');
export const SHARE_CATALOG = path.join(IOS_ROOT, 'MondropShare/Assets.xcassets/AppIcon.appiconset');

let sharpModule;
function sharp() {
  if (!sharpModule) {
    try {
      sharpModule = createRequire(path.join(IOS_ROOT, '..', 'backend', 'package.json'))('sharp');
    } catch {
      throw new Error('sharp not found: run `npm ci` in backend/ (the icons are rendered with the sharp that the backend ships)');
    }
  }
  return sharpModule;
}

// ---------------------------------------------------------------------------
// Geometry (a 1024 × 1024 canvas)
// ---------------------------------------------------------------------------

const f = (n) => +n.toFixed(2);

/** A rounded rectangle as a path. */
export const roundedRect = (x, y, w, h, r) =>
  `M${f(x + r)} ${f(y)}H${f(x + w - r)}A${r} ${r} 0 0 1 ${f(x + w)} ${f(y + r)}V${f(y + h - r)}A${r} ${r} 0 0 1 ${f(x + w - r)} ${f(y + h)}H${f(x + r)}A${r} ${r} 0 0 1 ${f(x)} ${f(y + h - r)}V${f(y + r)}A${r} ${r} 0 0 1 ${f(x + r)} ${f(y)}Z`;

/** A drop, tip up: a soft tip, convex flanks, a round belly. */
export function dropPath({ cx = 512, tipY, cy, R, tipR = 14, theta = 28, k1 = 120, k2 = 200 }) {
  const th = (theta * Math.PI) / 180;
  const py = tipY + (0.5 * tipR) / Math.tan(th);
  const cyq = py - tipR / Math.tan(th);
  const p0 = [cx + tipR, py];
  const p1 = [p0[0] + k1 * Math.sin(th), p0[1] + k1 * Math.cos(th)];
  const p2 = [cx + R, cy - k2];
  const mirror = (p) => [2 * cx - p[0], p[1]];
  const [l0, l1, l2] = [mirror(p0), mirror(p1), mirror(p2)];
  const P = (p) => `${f(p[0])} ${f(p[1])}`;
  return `M${P(l0)}Q${f(cx)} ${f(cyq)} ${P(p0)}C${P(p1)} ${P(p2)} ${f(cx + R)} ${f(cy)}A${R} ${R} 0 0 1 ${f(cx - R)} ${f(cy)}C${P(l2)} ${P(l1)} ${P(l0)}Z`;
}

/** Equalizer bars: rounded rectangles side by side, centred on (cx, cy). */
export function bars({ cx = 512, cy, w, gap, heights }) {
  const total = heights.length * w + (heights.length - 1) * gap;
  const x0 = cx - total / 2;
  return heights.map((h, i) => roundedRect(x0 + i * (w + gap), cy - h / 2, w, h, w / 2)).join('');
}

/** A polygon with rounded corners (a quadratic curve through each vertex). */
export function roundedPoly(pts, r) {
  const n = pts.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n], v = pts[i], q = pts[(i + 1) % n];
    const a = [p[0] - v[0], p[1] - v[1]], b = [q[0] - v[0], q[1] - v[1]];
    const la = Math.hypot(...a), lb = Math.hypot(...b);
    const ua = [a[0] / la, a[1] / la], ub = [b[0] / lb, b[1] / lb];
    const th = Math.acos(Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1])));
    const t = Math.min(r / Math.tan(th / 2), la * 0.48, lb * 0.48);
    const from = [v[0] + ua[0] * t, v[1] + ua[1] * t], to = [v[0] + ub[0] * t, v[1] + ub[1] * t];
    d += `${i === 0 ? 'M' : 'L'}${f(from[0])} ${f(from[1])}Q${f(v[0])} ${f(v[1])} ${f(to[0])} ${f(to[1])}`;
  }
  return d + 'Z';
}

// ---------------------------------------------------------------------------
// Colours: the background, the glyph and the light behind it, per appearance
// ---------------------------------------------------------------------------

const SCHEMES = {
  /** The icon: black drop on yellow. */
  yellow: { bg: ['#FFE24F', '#FFA900'], glyph: ['#2A2E40', '#0E0F14'], glow: '#FFFFFF', glowOpacity: 0.5, sheen: '#FFFFFF', sheenOpacity: 0.2, shadow: 'rgba(60,30,0,0.38)' },
  /** iOS 18 «dark» appearance: yellow drop on midnight blue. */
  dark: { bg: ['#2E3250', '#080910'], glyph: ['#FFE98A', '#FFB400'], glow: '#FFC400', glowOpacity: 0.11, sheen: '#8EA2FF', sheenOpacity: 0.16, shadow: 'rgba(0,0,0,0.55)' },
  /** iOS 18 «tinted» appearance: grey, the system puts the colour on it. */
  tinted: { bg: ['#2B2B2B', '#050505'], glyph: ['#FFFFFF', '#C9C9C9'], glow: '#FFFFFF', glowOpacity: 0.06, sheen: '#FFFFFF', sheenOpacity: 0.2, shadow: 'rgba(0,0,0,0.6)' },
  /** The twin: yellow house on blue (Home Assistant's blue family). */
  blue: { bg: ['#5F9BFF', '#1B3FC4'], glyph: ['#FFF1A8', '#FFC400'], glow: '#9CC2FF', glowOpacity: 0.2, sheen: '#FFFFFF', sheenOpacity: 0.2, shadow: 'rgba(5,15,70,0.5)' },
};

function frame(scheme, glyph, { glowAt = [512, 560], glowR = 520 } = {}) {
  const c = SCHEMES[scheme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.18" y2="1"><stop offset="0" stop-color="${c.bg[0]}"/><stop offset="1" stop-color="${c.bg[1]}"/></linearGradient>
  <radialGradient id="halo" cx="${glowAt[0]}" cy="${glowAt[1]}" r="${glowR}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${c.glow}" stop-opacity="${c.glowOpacity}"/><stop offset="1" stop-color="${c.glow}" stop-opacity="0"/></radialGradient>
  <radialGradient id="sheen" cx="300" cy="90" r="760" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${c.sheen}" stop-opacity="${c.sheenOpacity}"/><stop offset="1" stop-color="${c.sheen}" stop-opacity="0"/></radialGradient>
  <linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.glyph[0]}"/><stop offset="1" stop-color="${c.glyph[1]}"/></linearGradient>
  <filter id="blur" x="-30%" y="-30%" width="160%" height="170%"><feGaussianBlur stdDeviation="26"/></filter>
</defs>
<rect width="1024" height="1024" fill="url(#bg)"/>
<rect width="1024" height="1024" fill="url(#halo)"/>
<rect width="1024" height="1024" fill="url(#sheen)"/>
${glyph(c)}
</svg>
`;
}

/**
 * The glyph (holes included) and a soft shadow of its OUTER outline only: the shadow never falls into a hole, because a
 * cut-out has to show the background clean, not a smudge.
 */
const glyphLayer = (c, d, outer) => `<mask id="outside" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><rect width="1024" height="1024" fill="#fff"/><path d="${outer}" fill="#000"/></mask>
<g mask="url(#outside)"><g filter="url(#blur)" transform="translate(0 24)" opacity="0.9"><path d="${outer}" fill="${c.shadow}"/></g></g>
<path d="${d}" fill="url(#gl)" fill-rule="evenodd"/>`;

/** Just the background of an appearance (what a cut-out must show), for the tests. */
export const backgroundSvg = (scheme) => frame(scheme, () => '');

const DROP = { tipY: 150, cy: 610, R: 262, k1: 130, k2: 215 };

/** The app: a drop with the equalizer in its belly. `scheme`: yellow (the icon), dark, tinted (iOS 18). */
export function appIconSvg(scheme = 'yellow') {
  const drop = dropPath(DROP);
  const equalizer = bars({ cy: 640, w: 60, gap: 28, heights: [108, 218, 312, 218, 108] });
  return frame(scheme, (c) => glyphLayer(c, drop + equalizer, drop));
}

/** The share sheet: the same drop that takes a link in, a down arrow where the equalizer was. */
export function shareIconSvg(scheme = 'yellow') {
  const drop = dropPath(DROP);
  const arrow = roundedPoly([[474, 478], [550, 478], [550, 604], [640, 604], [512, 800], [384, 604], [474, 604]], 24);
  return frame(scheme, (c) => glyphLayer(c, drop + arrow, drop));
}

/** The twin (Casamon TV): Casamon's house with the same equalizer. */
export function houseIconSvg(scheme = 'blue') {
  const house = roundedPoly([[512, 150], [858, 452], [858, 858], [166, 858], [166, 452]], 64);
  const equalizer = bars({ cy: 600, w: 56, gap: 32, heights: [110, 230, 330, 230, 110] });
  return frame(scheme, (c) => glyphLayer(c, house + equalizer, house));
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/** An opaque RGB PNG of the art at `size` × `size`: iOS icons must not carry an alpha channel. */
export async function opaquePng(svg, size = 1024) {
  return sharp()(Buffer.from(svg), { density: 72 })
    .resize(size, size, { kernel: 'lanczos3' })
    .flatten({ background: '#000000' })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** The macOS icon: an 824 px rounded tile with a soft shadow, centred on a transparent 1024 canvas, then scaled to `px`. */
export async function macPng(svg, px) {
  const art = await sharp()(Buffer.from(svg), { density: 72 }).resize(824, 824, { kernel: 'lanczos3' }).png().toBuffer();
  const mask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="824" height="824"><rect width="824" height="824" rx="185" fill="#fff"/></svg>');
  const tile = await sharp()(art).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const shadow = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><filter id="b" x="-10%" y="-10%" width="120%" height="125%"><feGaussianBlur stdDeviation="12"/></filter><rect x="100" y="110" width="824" height="824" rx="185" fill="#000" fill-opacity="0.3" filter="url(#b)"/></svg>',
  );
  // two passes: sharp applies `composite` AFTER `resize`, so the 1024 canvas is finished first and shrunk after
  const canvas = await sharp()({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: shadow }, { input: tile, left: 100, top: 100 }])
    .png()
    .toBuffer();
  return px === 1024 ? canvas : sharp()(canvas).resize(px, px, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
}

// ---------------------------------------------------------------------------
// The asset catalogs
// ---------------------------------------------------------------------------

export const MAC_SIZES = [[16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2]];
const macFile = (pt, scale) => `icon_${pt}x${pt}${scale === 2 ? '@2x' : ''}.png`;

/** `Contents.json` of an AppIcon set: the iOS 1024 (with the dark and tinted ones when given) and the ten macOS sizes. */
export function catalogContents({ dark = false, tinted = false } = {}) {
  const ios = { idiom: 'universal', platform: 'ios', size: '1024x1024' };
  const images = [{ filename: 'AppIcon.png', ...ios }];
  if (dark) images.push({ appearances: [{ appearance: 'luminosity', value: 'dark' }], filename: 'AppIcon-Dark.png', ...ios });
  if (tinted) images.push({ appearances: [{ appearance: 'luminosity', value: 'tinted' }], filename: 'AppIcon-Tinted.png', ...ios });
  for (const [pt, scale] of MAC_SIZES) images.push({ filename: macFile(pt, scale), idiom: 'mac', scale: `${scale}x`, size: `${pt}x${pt}` });
  return { images, info: { author: 'xcode', version: 1 } };
}

/** Writes an AppIcon set into `dir`. `art` = { light, dark?, tinted? } as SVG text. */
export async function writeCatalog(dir, art) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'AppIcon.png'), await opaquePng(art.light));
  if (art.dark) await writeFile(path.join(dir, 'AppIcon-Dark.png'), await opaquePng(art.dark));
  if (art.tinted) await writeFile(path.join(dir, 'AppIcon-Tinted.png'), await opaquePng(art.tinted));
  for (const [pt, scale] of MAC_SIZES) await writeFile(path.join(dir, macFile(pt, scale)), await macPng(art.light, pt * scale));
  await writeFile(path.join(dir, 'Contents.json'), JSON.stringify(catalogContents({ dark: !!art.dark, tinted: !!art.tinted }), null, 2) + '\n');
}

/** The SVG sources kept in `ios/icon/`, by file name: what the catalogs are drawn from. */
export function sources() {
  return {
    'mondrop.svg': appIconSvg('yellow'),
    'mondrop-dark.svg': appIconSvg('dark'),
    'mondrop-tinted.svg': appIconSvg('tinted'),
    'mondrop-share.svg': shareIconSvg('yellow'),
    'house.svg': houseIconSvg('blue'),
  };
}

async function main(argv) {
  const at = argv.indexOf('--house');
  if (at >= 0) {
    if (!argv[at + 1]) throw new Error('--house needs a folder');
    const dir = path.resolve(argv[at + 1]);
    const svg = houseIconSvg('blue');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'house.svg'), svg);
    for (const size of [1024, 130, 80]) await writeFile(path.join(dir, `house-${size}.png`), await opaquePng(svg, size));
    console.log(`the house twin: house.svg, house-1024.png, house-130.png, house-80.png in ${dir}`);
    return;
  }
  await mkdir(ICON_DIR, { recursive: true });
  for (const [name, svg] of Object.entries(sources())) await writeFile(path.join(ICON_DIR, name), svg);
  await writeCatalog(APP_CATALOG, { light: appIconSvg('yellow'), dark: appIconSvg('dark'), tinted: appIconSvg('tinted') });
  await writeCatalog(SHARE_CATALOG, { light: shareIconSvg('yellow') });
  console.log('Mondrop icons: ios/icon/*.svg, Mondrop/Assets.xcassets and MondropShare/Assets.xcassets rewritten');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(String(err.message ?? err));
    process.exit(1);
  });
}
