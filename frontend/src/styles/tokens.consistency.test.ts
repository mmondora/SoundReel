import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ADR-0025: the site and Mondrop share ONE set of design tokens. The app's numbers live in
// `ios/MondropKit/MondropPalette.swift` (with their contrast tests); the site has `tokens.css` with the same values, and every other
// colour of the site is made from them. Michele, 10 November: «giallo e nero - Mondrop like ( e devon andare insieme gli stili )».
// This test turns each `RGB(r, g, b)` of the Swift file into hex and compares it with the token of the same role: change a colour on
// one side and it names the other. It also keeps the old green accent out of every stylesheet.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');
const SWIFT = readFileSync(join(HERE, '../../../ios/MondropKit/MondropPalette.swift'), 'utf8');
const TOKENS = readFileSync(join(HERE, 'tokens.css'), 'utf8');
const INDEX = readFileSync(join(HERE, 'index.css'), 'utf8');

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

const floats = (text: string): number[] => text.split(',').map((s) => Number(s.trim()));

/** `static let <name> = RGB(r, g, b)` → `#RRGGBB`. */
function swiftColour(name: string): string {
  const m = new RegExp(`static let ${name}\\s*=\\s*RGB\\(([^)]*)\\)`).exec(SWIFT);
  if (!m) throw new Error(`MondropPalette.swift has no colour «${name}»`);
  const [r, g, b] = floats(m[1]);
  return toHex(r, g, b);
}

/** `static let <name> = 0.72` → 0.72. */
function swiftNumber(name: string): number {
  const m = new RegExp(`static let ${name}\\s*=\\s*([0-9.]+)`).exec(SWIFT);
  if (!m) throw new Error(`MondropPalette.swift has no number «${name}»`);
  return Number(m[1]);
}

/** The three system backgrounds of iOS in dark mode, as hex. */
function swiftSystemBackgrounds(): string[] {
  const m = /static let systemDarkBackgrounds\s*=\s*\[([^\]]*)\]/.exec(SWIFT);
  if (!m) throw new Error('MondropPalette.swift has no systemDarkBackgrounds');
  return [...m[1].matchAll(/RGB\(([^)]*)\)/g)].map((x) => {
    const [r, g, b] = floats(x[1]);
    return toHex(r, g, b);
  });
}

/** The value of `--name: …;` in tokens.css. */
function token(name: string): string {
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(TOKENS);
  if (!m) throw new Error(`tokens.css has no ${name}`);
  return m[1].trim();
}

describe('the colours of the site are the colours of Mondrop', () => {
  it.each([
    ['--mp-accent', 'accent'],
    ['--mp-on-accent', 'onAccent'],
    ['--mp-text', 'text'],
    ['--mp-bg-top', 'backgroundTop'],
    ['--mp-bg-bottom', 'backgroundBottom'],
    ['--mp-error', 'error'],
  ])('%s is the %s of MondropPalette.swift', (prop, swiftName) => {
    expect(token(prop).toUpperCase()).toBe(swiftColour(swiftName));
  });

  it('the three backgrounds of the lists are the system backgrounds of iOS in dark mode', () => {
    const [bg, bg2, bg3] = swiftSystemBackgrounds();
    expect(token('--mp-system-bg').toUpperCase()).toBe(bg);
    expect(token('--mp-system-bg-2').toUpperCase()).toBe(bg2);
    expect(token('--mp-system-bg-3').toUpperCase()).toBe(bg3);
  });

  it.each([
    ['--mp-secondary-opacity', 'secondaryTextOpacity'],
    ['--mp-pill-fill-opacity', 'pillFillOpacity'],
    ['--mp-card-fill-opacity', 'cardFillOpacity'],
  ])('%s is the %s of MondropPalette.swift', (prop, swiftName) => {
    expect(Number(token(prop))).toBe(swiftNumber(swiftName));
  });

  it('the yellow is the one accent: it is yellow (red and green high, blue low) and black reads on it', () => {
    const accent = token('--mp-accent');
    expect(accent.toUpperCase()).toBe('#FFD60A');
    expect(token('--mp-on-accent').toUpperCase()).toBe('#000000');
  });
});

describe('every colour of the old styles is made from the tokens', () => {
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(INDEX)?.[1] ?? '';
  const declared = (name: string): string => new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(root)?.[1].trim() ?? '';

  it.each([
    '--bg-primary', '--bg-secondary', '--bg-card', '--bg-hover', '--bg-input',
    '--text-primary', '--text-secondary', '--text-muted',
    '--accent', '--accent-hover', '--accent-soft',
    '--border', '--border-light', '--error',
  ])('%s is defined from a --mp-* token, never from a hex', (name) => {
    const value = declared(name);
    expect(value, `${name} is not declared in :root of index.css`).not.toBe('');
    expect(value).toMatch(/var\(--mp-/);
    expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('tokens.css is loaded by index.css before anything uses it', () => {
    expect(INDEX).toMatch(/@import\s+['"]\.\/tokens\.css['"]/);
  });
});

describe('the old green accent is gone from every stylesheet and every component', () => {
  const OLD_GREEN = [/#3ddc97/i, /61,\s*220,\s*151/, /#2fc986/i];

  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return files(full);
      return /\.(css|tsx?)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
    });

  it('no file under src/ names it', () => {
    const found = files(SRC).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return OLD_GREEN.filter((re) => re.test(text)).map(() => file.slice(SRC.length + 1));
    });
    expect(found).toEqual([]);
  });
});
