#!/usr/bin/env python3
"""Generate the watchOS AppIcon from the phone app's 1024pt master.

The watch target ships no asset catalog of its own, so App Store Connect
rejects the embedded watch bundle with 90391 (no CFBundleIconFiles) and
90713 (no CFBundleIconName). watchOS icons must be opaque, so the phone
master's alpha channel is flattened rather than copied.
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png")
DST_DIR = os.path.join(ROOT, "ios/Watch/Assets.xcassets/AppIcon.appiconset")
DST = os.path.join(DST_DIR, "AppIcon.png")

src = Image.open(SRC).convert("RGBA")
w, h = src.size
if (w, h) != (1024, 1024):
    raise SystemExit(f"expected a 1024x1024 master, got {w}x{h}")

alpha = src.getchannel("A")
print(f"alpha range: {alpha.getextrema()}")
corners = [alpha.getpixel(p) for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
print(f"corner alpha: {corners}")

# Flatten onto the icon's own edge colour so a transparent corner does not
# become a white notch under the watch's circular mask.
edge = src.convert("RGB").getpixel((w // 2, 2))
print(f"edge colour: {edge}")
flat = Image.new("RGB", (w, h), edge)
flat.paste(src, mask=alpha)

os.makedirs(DST_DIR, exist_ok=True)
flat.save(DST, "PNG")
print(f"wrote {DST} ({flat.mode} {flat.size})")