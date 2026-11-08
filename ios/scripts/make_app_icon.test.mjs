// node --test ios/scripts/make_app_icon.test.mjs   (needs sharp from backend/node_modules; no network)
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APP_CATALOG, ICON_DIR, MAC_SIZES, SHARE_CATALOG,
  appIconSvg, backgroundSvg, catalogContents, houseIconSvg, macPng, opaquePng, shareIconSvg, sources, writeCatalog,
} from './make_app_icon.mjs';

const sharp = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend/package.json'))('sharp');
const ihdr = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png[25] });
const RGB = 2; // PNG colour type: truecolour, no alpha
const RGBA = 6;

/** The RGB of one pixel of an image buffer. */
async function pixel(buffer, x, y) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [data[at], data[at + 1], data[at + 2]];
}
const near = (a, b, tolerance = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

test('the art is plain vector: 1024 canvas, no text, no picture inside', () => {
  const all = Object.entries(sources());
  assert.deepEqual(all.map(([name]) => name).sort(), ['house.svg', 'mondrop-dark.svg', 'mondrop-share.svg', 'mondrop-tinted.svg', 'mondrop.svg']);
  for (const [name, svg] of all) {
    assert.match(svg, /viewBox="0 0 1024 1024"/, name);
    assert.doesNotMatch(svg, /<text|<image|href=|font-family/, `${name} must not depend on a font or an embedded picture`);
  }
});

test('an iOS picture is an opaque 1024 RGB PNG: App Store Connect refuses an alpha channel', async () => {
  for (const svg of [appIconSvg('yellow'), appIconSvg('dark'), appIconSvg('tinted'), shareIconSvg('yellow')]) {
    assert.deepEqual(ihdr(await opaquePng(svg)), { width: 1024, height: 1024, colorType: RGB });
  }
});

test('a cut-out shows the background CLEAN, never a smudge of the shadow (the first draft smudged them)', async () => {
  const spots = {
    app: { make: appIconSvg, points: [[336, 640], [424, 640], [512, 640], [600, 640], [688, 640]] },
    share: { make: shareIconSvg, points: [[512, 540], [512, 700]] },
    house: { make: houseIconSvg, points: [[336, 600], [424, 600], [512, 600], [600, 600], [688, 600]] },
  };
  const schemes = { app: ['yellow', 'dark', 'tinted'], share: ['yellow'], house: ['blue'] };
  for (const [what, { make, points }] of Object.entries(spots)) {
    for (const scheme of schemes[what]) {
      const icon = await opaquePng(make(scheme));
      const background = await opaquePng(backgroundSvg(scheme));
      for (const [x, y] of points) {
        const got = await pixel(icon, x, y);
        const want = await pixel(background, x, y);
        assert.ok(near(got, want), `${what}/${scheme} at ${x},${y}: ${got} is not the background ${want}`);
      }
    }
  }
});

test('the glyph is where it should be: the belly of the drop is dark on yellow, yellow on the dark appearance', async () => {
  const [r, g, b] = await pixel(await opaquePng(appIconSvg('yellow')), 512, 840); // below the bars, still in the belly
  assert.ok(r < 80 && g < 80 && b < 90, `black drop expected, got ${[r, g, b]}`);
  const [dr, dg, db] = await pixel(await opaquePng(appIconSvg('dark')), 512, 840);
  assert.ok(dr > 200 && dg > 140 && db < 90, `yellow drop expected, got ${[dr, dg, db]}`);
});

test('the catalog lists the dark and tinted pictures only when it has them, and the ten macOS sizes', () => {
  const plain = catalogContents();
  assert.equal(plain.images.filter((i) => i.platform === 'ios').length, 1);
  assert.equal(plain.images.filter((i) => i.idiom === 'mac').length, MAC_SIZES.length);
  const full = catalogContents({ dark: true, tinted: true });
  const ios = full.images.filter((i) => i.platform === 'ios');
  assert.deepEqual(ios.map((i) => i.appearances?.[0]?.value ?? 'default'), ['default', 'dark', 'tinted']);
  assert.deepEqual(ios.map((i) => i.filename), ['AppIcon.png', 'AppIcon-Dark.png', 'AppIcon-Tinted.png']);
  for (const i of ios.slice(1)) assert.deepEqual(i.appearances[0].appearance, 'luminosity');
});

test('a written catalog is complete: every file listed exists, with the size it says', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mondrop-icon-'));
  try {
    await writeCatalog(dir, { light: appIconSvg('yellow'), dark: appIconSvg('dark'), tinted: appIconSvg('tinted') });
    const contents = JSON.parse(await readFile(path.join(dir, 'Contents.json'), 'utf8'));
    assert.deepEqual(contents, catalogContents({ dark: true, tinted: true }));
    for (const image of contents.images) {
      const png = await readFile(path.join(dir, image.filename));
      const head = ihdr(png);
      if (image.platform === 'ios') assert.deepEqual(head, { width: 1024, height: 1024, colorType: RGB }, image.filename);
      else {
        const px = parseInt(image.size, 10) * parseInt(image.scale, 10);
        assert.deepEqual([head.width, head.height, head.colorType], [px, px, RGBA], image.filename);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the macOS tile has transparent corners and a shadow, and the artwork in the middle', async () => {
  const mac = await macPng(appIconSvg('yellow'), 1024);
  const { data, info } = await sharp(mac).raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
  assert.equal(alphaAt(0, 0), 0, 'the corner of the canvas is transparent');
  assert.equal(alphaAt(512, 512), 255, 'the artwork is opaque');
  assert.ok(alphaAt(512, 940) > 0 && alphaAt(512, 940) < 255, 'the shadow fades under the tile');
});

test('the SVG sources kept in ios/icon/ are what the script draws (nobody edited one by hand)', async () => {
  for (const [name, svg] of Object.entries(sources())) {
    assert.equal(await readFile(path.join(ICON_DIR, name), 'utf8'), svg, `${name} is out of date: run node ios/scripts/make_app_icon.mjs`);
  }
});

test('the committed catalogs are valid: the files they list exist, iOS ones are opaque 1024', async () => {
  for (const [dir, appearances] of [[APP_CATALOG, ['default', 'dark', 'tinted']], [SHARE_CATALOG, ['default']]]) {
    const contents = JSON.parse(await readFile(path.join(dir, 'Contents.json'), 'utf8'));
    const ios = contents.images.filter((i) => i.platform === 'ios');
    assert.deepEqual(ios.map((i) => i.appearances?.[0]?.value ?? 'default'), appearances, dir);
    for (const image of contents.images) {
      const head = ihdr(await readFile(path.join(dir, image.filename)));
      if (image.platform === 'ios') assert.deepEqual(head, { width: 1024, height: 1024, colorType: RGB }, `${dir}/${image.filename}`);
    }
  }
});
