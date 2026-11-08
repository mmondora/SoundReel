#!/usr/bin/env python3
"""Regenerate the Share Extension icon (ios/MondropShare/Assets.xcassets) from the app icon.

Design: current app icon (house) + yellow veil + very light blur, with the iOS share
glyph (open box + up arrow) on top. iOS gets a full-bleed opaque 1024 PNG (no alpha);
macOS gets the usual rounded tile + shadow in the standard sizes.

    python3 ios/scripts/make_share_icon.py            # veil 0.55, blur 5 (installed: "E2")
    python3 ios/scripts/make_share_icon.py --veil 0.42  # more house ("E1")
    python3 ios/scripts/make_share_icon.py --veil 0.68  # more yellow ("E3")

Needs Pillow (pip install pillow). Source = ios/Mondrop/Assets.xcassets/AppIcon.appiconset/AppIcon.png.
"""
import argparse
import json
import math
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
APP_ICON = os.path.join(ROOT, 'Mondrop/Assets.xcassets/AppIcon.appiconset/AppIcon.png')
CATALOG = os.path.join(ROOT, 'MondropShare/Assets.xcassets')
S, SS, STROKE = 1024, 3, 66


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def vgradient(top, bottom):
    col = Image.new('RGB', (1, S))
    for y in range(S):
        col.putpixel((0, y), lerp(top, bottom, y / (S - 1)))
    return col.resize((S, S))


def glow(base, center, radius, color, alpha):
    layer = Image.new('L', (S, S), 0)
    cx, cy = center
    ImageDraw.Draw(layer).ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=int(255 * alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(radius * 0.45))
    return Image.composite(Image.new('RGB', (S, S), color), base, layer)


def arc(cx, cy, r, a0, a1, n=28):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


def glyph_paths():
    """Share symbol in 1024 space: rounded open-top box + arrow (shaft + chevron)."""
    W, H = 470, 570
    cx, gy = 512, 232
    x0, x1 = cx - W / 2, cx + W / 2
    yt, y1 = gy + 0.36 * H, gy + H
    r, gap = 100, 0.27 * W
    box = (
        [(cx - gap, yt), (x0 + r, yt)]
        + arc(x0 + r, yt + r, r, 270, 180) + [(x0, y1 - r)]
        + arc(x0 + r, y1 - r, r, 180, 90) + [(x1 - r, y1)]
        + arc(x1 - r, y1 - r, r, 90, 0) + [(x1, yt + r)]
        + arc(x1 - r, yt + r, r, 0, -90) + [(cx + gap, yt)]
    )
    a = 0.21 * W
    return [box, [(cx, gy + 0.64 * H), (cx, gy)], [(cx - a, gy + a), (cx, gy), (cx + a, gy + a)]]


def stroke_mask(width):
    big = Image.new('L', (S * SS, S * SS), 0)
    d = ImageDraw.Draw(big)
    for pts in glyph_paths():
        p = [(x * SS, y * SS) for x, y in pts]
        for (ax, ay), (bx, by) in zip(p, p[1:]):
            d.line([(ax, ay), (bx, by)], fill=255, width=int(width * SS))
        rad = width * SS / 2
        for x, y in p:
            d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=255)
    return big.resize((S, S), Image.LANCZOS)


def paste_color(base, mask, color, offset=(0, 0), blur=0, alpha=1.0):
    m = mask
    if offset != (0, 0):
        shifted = Image.new('L', (S, S), 0)
        shifted.paste(m, offset)
        m = shifted
    if blur:
        m = m.filter(ImageFilter.GaussianBlur(blur))
    if alpha < 1.0:
        m = m.point(lambda v: int(v * alpha))
    return Image.composite(Image.new('RGB', (S, S), color), base, m)


def build_icon(veil, blur):
    art = Image.open(APP_ICON).convert('RGB').filter(ImageFilter.GaussianBlur(blur))
    yellow = glow(vgradient((255, 229, 82), (255, 172, 0)), (330, 250), 380, (255, 250, 210), 0.55)
    bg = Image.blend(art, yellow, veil)
    outline, fill = stroke_mask(STROKE + 46), stroke_mask(STROKE)
    img = paste_color(bg, outline, (40, 22, 0), offset=(0, 22), blur=16, alpha=0.38)
    img = paste_color(img, outline, (58, 34, 0))
    return paste_color(img, fill, (255, 255, 255))


def write_appiconset(art):
    out = os.path.join(CATALOG, 'AppIcon.appiconset')
    os.makedirs(out, exist_ok=True)
    art.save(os.path.join(out, 'AppIcon.png'), 'PNG', optimize=True)  # RGB: iOS forbids alpha

    # macOS does not mask icons: 824px rounded tile + soft shadow on a transparent 1024 canvas.
    q = 4
    mask_big = Image.new('L', (824 * q, 824 * q), 0)
    ImageDraw.Draw(mask_big).rounded_rectangle((0, 0, 824 * q - 1, 824 * q - 1), radius=185 * q, fill=255)
    mask = mask_big.resize((824, 824), Image.LANCZOS)
    tile = art.resize((824, 824), Image.LANCZOS).convert('RGBA')
    tile.putalpha(mask)
    shadow_alpha = Image.new('L', (1024, 1024), 0)
    shadow_alpha.paste(mask.point(lambda v: int(v * 0.30)), (100, 110))
    shadow = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    shadow.putalpha(shadow_alpha.filter(ImageFilter.GaussianBlur(12)))
    canvas = Image.alpha_composite(Image.new('RGBA', (1024, 1024), (0, 0, 0, 0)), shadow)
    canvas.alpha_composite(tile, (100, 100))

    images = [{'filename': 'AppIcon.png', 'idiom': 'universal', 'platform': 'ios', 'size': '1024x1024'}]
    for pt, scale, px in [(16, 1, 16), (16, 2, 32), (32, 1, 32), (32, 2, 64), (128, 1, 128), (128, 2, 256),
                          (256, 1, 256), (256, 2, 512), (512, 1, 512), (512, 2, 1024)]:
        name = f'icon_{pt}x{pt}' + ('@2x' if scale == 2 else '') + '.png'
        canvas.resize((px, px), Image.LANCZOS).save(os.path.join(out, name), 'PNG', optimize=True)
        images.append({'filename': name, 'idiom': 'mac', 'scale': f'{scale}x', 'size': f'{pt}x{pt}'})
    for path, payload in (
        (os.path.join(out, 'Contents.json'), {'images': images, 'info': {'author': 'xcode', 'version': 1}}),
        (os.path.join(CATALOG, 'Contents.json'), {'info': {'author': 'xcode', 'version': 1}}),
    ):
        with open(path, 'w') as f:
            json.dump(payload, f, indent=2)
            f.write('\n')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--veil', type=float, default=0.55, help='yellow veil over the house, 0..1 (default 0.55)')
    ap.add_argument('--blur', type=float, default=5, help='gaussian blur radius on the house (default 5)')
    args = ap.parse_args()
    write_appiconset(build_icon(args.veil, args.blur))
    print(f'wrote {CATALOG}/AppIcon.appiconset (veil={args.veil}, blur={args.blur})')
