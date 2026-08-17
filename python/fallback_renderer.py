"""
Wallermax H1 — Fallback preview renderer.

Used when Blender is NOT available. Reads a Wallermax World Model JSON and
produces an MP4 that visualizes:

  - the room (checkerboard floor + walls + ceiling outline)
  - each entity as a colored 2D disk / box / cylinder icon at its X,Y position
  - lights as colored glows
  - the camera frustum as a triangle
  - the events as animated position / color / power changes over time
  - a subtle vignette and grain driven by `world.aesthetic`

This is NOT a photorealistic render — it is a schematic / look-dev preview
that proves the pipeline produces an MP4. The Blender compiler remains the
"real" renderer; this fallback exists so the pipeline can be exercised in
environments without Blender.

Dependencies:
  - Python 3.10+ (standard library)
  - Pillow  (pip install Pillow)
  - ffmpeg  (must be on PATH; used to encode the MP4)

No numpy required — pixel ops are done with PIL.ImageChops / Image.point.

Invocation:
    python3 fallback_renderer.py world.json output_dir [width] [height] [fps] [duration]

Outputs:
    output_dir/render.mp4
    output_dir/poster.png
"""

import json
import math
import os
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageChops


# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────
def list_ffmpeg_encoders():
    """Return the set of encoder names that ffmpeg supports on this machine.

    Different ffmpeg builds ship with different encoders. The "essentials"
    build on Windows includes libx264, but a "minimal" or "shared" build
    might not. We probe `ffmpeg -encoders` once and cache the result so we
    can fall back to a different encoder when libx264 is unavailable.
    """
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            check=True,
        ).stdout.decode("utf-8", errors="replace")
    except Exception:
        return set()
    encoders = set()
    for line in out.splitlines():
        # Encoder lines look like: " V..... libx264             H.264 ..."
        # The first non-space char is the encoder type (V=video, A=audio).
        parts = line.split()
        if len(parts) >= 2 and line.startswith(" V"):
            encoders.add(parts[1])
    return encoders


_FFMPEG_ENCODERS_CACHE = None
def ffmpeg_encoders():
    global _FFMPEG_ENCODERS_CACHE
    if _FFMPEG_ENCODERS_CACHE is None:
        _FFMPEG_ENCODERS_CACHE = list_ffmpeg_encoders()
    return _FFMPEG_ENCODERS_CACHE


def _build_ffmpeg_command(mp4_path, width, height, fps):
    """Build an ffmpeg command that encodes raw RGB frames into an MP4.

    Probes ffmpeg's available encoders and picks the best one, in this
    preference order:
      1. libx264      (best — H.264, plays in all browsers)
      2. h264_nvenc   (H.264 NVIDIA GPU — fast, plays in all browsers)
      3. h264_qsv     (H.264 Intel QuickSync — fast, plays in all browsers)
      4. h264_amf     (H.264 AMD AMF — fast, plays in all browsers)
      5. libx265      (HEVC — plays in some browsers, not all)
      6. mpeg4        (MPEG-4 Part 2 — Chrome/Firefox CANNOT play this inline)
      7. None         (use ffmpeg's default)

    All variants include `-movflags +faststart` so the browser can start
    playback immediately without downloading the whole file.
    """
    encs = ffmpeg_encoders()
    # The `-movflags +faststart` flag moves the `moov` atom to the start of
    # the MP4 so the browser can start playback immediately.
    faststart = ["-movflags", "+faststart"]
    # IMPORTANT: libx264 (software) comes FIRST because it always works.
    # Hardware encoders (h264_nvenc, h264_qsv, h264_amf) come AFTER because
    # they may be listed in ffmpeg's encoders but fail at runtime when the
    # corresponding hardware (NVIDIA GPU, Intel QSV, AMD AMF) is not present.
    if "libx264" in encs:
        codec, pix_fmt, extra = "libx264", "yuv420p", ["-crf", "20", "-preset", "medium"] + faststart
        print("WALLERMAX_FALLBACK_ENCODER: libx264 (H.264 software)")
    elif "h264_qsv" in encs:
        codec, pix_fmt, extra = "h264_qsv", "yuv420p", ["-global_quality", "22"] + faststart
        print("WALLERMAX_FALLBACK_ENCODER: h264_qsv (H.264 Intel QuickSync)")
    elif "h264_amf" in encs:
        codec, pix_fmt, extra = "h264_amf", "yuv420p", ["-quality", "balanced"] + faststart
        print("WALLERMAX_FALLBACK_ENCODER: h264_amf (H.264 AMD AMF)")
    elif "h264_nvenc" in encs:
        codec, pix_fmt, extra = "h264_nvenc", "yuv420p", ["-preset", "p4", "-rc", "vbr", "-cq", "22"] + faststart
        print("WALLERMAX_FALLBACK_ENCODER: h264_nvenc (H.264 NVIDIA GPU)")
    elif "libx265" in encs:
        codec, pix_fmt, extra = "libx265", "yuv420p", ["-crf", "24", "-preset", "medium", "-tag:v", "hvc1"] + faststart
        print("WALLERMAX_FALLBACK_ENCODER: libx265 (HEVC — may not play in all browsers)")
    elif "mpeg4" in encs:
        codec, pix_fmt, extra = "mpeg4", "yuv420p", ["-q:v", "5"] + faststart
        print("WALLERMAX_FALLBACK_ENCODER: mpeg4 (MPEG-4 Part 2 — NOT playable inline in Chrome/Firefox)")
    else:
        codec, pix_fmt, extra = None, "yuv420p", [] + faststart
        print("WALLERMAX_FALLBACK_FFMPEG_WARN: no known encoder found; "
              "using ffmpeg's default for .mp4")
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}", "-r", str(fps), "-i", "-",
    ]
    if codec:
        cmd += ["-c:v", codec]
    cmd += ["-pix_fmt", pix_fmt] + extra + [str(mp4_path)]
    return cmd


def norm_color(c, default=0.8):
    if not c:
        return (int(default * 255), int(default * 255), int(default * 255))
    if len(c) == 3:
        c = list(c) + [1.0]
    return (
        int(max(0.0, min(1.0, float(c[0]))) * 255),
        int(max(0.0, min(1.0, float(c[1]))) * 255),
        int(max(0.0, min(1.0, float(c[2]))) * 255),
    )


def kelvin_to_rgb(kelvin):
    k = max(1000.0, min(40000.0, float(kelvin))) / 100.0
    if k <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(k) - 161.1195681661
        b = 0.0 if k <= 19 else 138.5177312231 * math.log(k - 10) - 305.0447927307
    else:
        r = 329.698727446 * ((k - 60) ** -0.1332047592)
        g = 288.1221695283 * ((k - 60) ** -0.0755148492)
        b = 255.0
    return (
        int(max(0.0, min(1.0, r / 255.0)) * 255),
        int(max(0.0, min(1.0, g / 255.0)) * 255),
        int(max(0.0, min(1.0, b / 255.0)) * 255),
    )


# ─────────────────────────────────────────────────────────────────────────
# World-to-screen projection (top-down, orthographic)
# ─────────────────────────────────────────────────────────────────────────
class Projector:
    """Top-down orthographic projector.

    Maps world (X, Y) to screen (px, py). Z is used only for sorting
    (entities with higher Z are drawn later so they appear "above").
    """

    def __init__(self, world_block, width, height, margin=80):
        env = world_block.get("environment", {}) or {}
        self.gravity = env.get("gravity", [0, 0, -9.81])
        self.width = width
        self.height = height
        self.margin = margin
        self.xmin, self.xmax, self.ymin, self.ymax = self._compute_bounds(world_block)

    def _compute_bounds(self, world_block):
        xs, ys = [-6, 6], [-6, 6]
        for e in world_block.get("entities", []):
            t = e.get("transform", {}) or {}
            pos = t.get("position", [0, 0, 0])
            if len(pos) >= 2:
                xs.append(float(pos[0]))
                ys.append(float(pos[1]))
            g = e.get("geometry", {}) or {}
            if e.get("type") == "room":
                dims = g.get("dimensions", [10, 10, 3])
                xs.extend([-dims[0] / 2, dims[0] / 2])
                ys.extend([-dims[1] / 2, dims[1] / 2])
        xmin, xmax = min(xs) - 2, max(xs) + 2
        ymin, ymax = min(ys) - 2, max(ys) + 2
        aspect = self.width / max(1, self.height)
        cx = (xmin + xmax) / 2
        cy = (ymin + ymax) / 2
        half_w = (xmax - xmin) / 2
        half_h = (ymax - ymin) / 2
        if half_w / half_h > aspect:
            half_h = half_w / aspect
        else:
            half_w = half_h * aspect
        return cx - half_w, cx + half_w, cy - half_h, cy + half_h

    def world_to_screen(self, x, y):
        px = self.margin + (x - self.xmin) / (self.xmax - self.xmin) * (self.width - 2 * self.margin)
        # Y is flipped (screen Y grows downward).
        py = self.margin + (self.ymax - y) / (self.ymax - self.ymin) * (self.height - 2 * self.margin)
        return int(px), int(py)

    def world_scale(self, length):
        return length / (self.xmax - self.xmin) * (self.width - 2 * self.margin)


# ─────────────────────────────────────────────────────────────────────────
# Drawing primitives
# ─────────────────────────────────────────────────────────────────────────
def draw_checkerboard(draw, proj, room_dims, tile=0.6):
    x, y, _ = room_dims
    nx = max(2, int(round(x / tile)))
    ny = max(2, int(round(y / tile)))
    for ix in range(nx):
        for iy in range(ny):
            wx = -x / 2 + (ix + 0.5) * (x / nx)
            wy = -y / 2 + (iy + 0.5) * (y / ny)
            px, py = proj.world_to_screen(wx, wy)
            sx = proj.world_scale(x / nx)
            sy = proj.world_scale(y / ny)
            color = (245, 245, 245) if (ix + iy) % 2 == 0 else (20, 22, 28)
            draw.rectangle(
                [px - sx // 2, py - sy // 2, px + sx // 2, py + sy // 2],
                fill=color,
            )


def draw_room_outline(draw, proj, room_dims):
    x, y, _ = room_dims
    corners = [(-x / 2, -y / 2), (x / 2, -y / 2), (x / 2, y / 2), (-x / 2, y / 2)]
    pts = [proj.world_to_screen(cx, cy) for cx, cy in corners]
    draw.line(pts + [pts[0]], fill=(120, 130, 150), width=2)


def draw_entity(draw, proj, e, t_now, frame_img, blur_layer):
    typ = e.get("type", "")
    g = e.get("geometry", {}) or {}
    t = e.get("transform", {}) or {}
    pos = t.get("position", [0, 0, 0])
    pos = apply_events_position(e, pos, t_now)
    px, py = proj.world_to_screen(pos[0], pos[1])

    if typ == "room":
        return  # already drawn as floor

    mat = e.get("material", {}) or {}
    base_color = norm_color(mat.get("base_color"), 0.7)

    if typ in {"sphere", "ball"}:
        r = float(g.get("radius", 0.5))
        sr = max(4, int(proj.world_scale(r * 2) / 2))
        draw.ellipse([px - sr, py - sr, px + sr, py + sr], fill=base_color, outline=(255, 255, 255))
        # Subtle highlight
        draw.ellipse(
            [px - sr // 3, py - sr // 3, px + sr // 3, py + sr // 3],
            fill=tuple(min(255, c + 60) for c in base_color),
        )
    elif typ in {"box", "cube"}:
        dims = g.get("dimensions", [1, 1, 1])
        sw = max(4, int(proj.world_scale(dims[0]) / 2))
        sh = max(4, int(proj.world_scale(dims[1]) / 2))
        draw.rectangle(
            [px - sw, py - sh, px + sw, py + sh],
            fill=base_color,
            outline=(255, 255, 255),
        )
    elif typ == "cylinder":
        r = float(g.get("radius", 0.5))
        sr = max(4, int(proj.world_scale(r * 2) / 2))
        draw.ellipse([px - sr, py - sr, px + sr, py + sr], fill=base_color, outline=(255, 255, 255))
    elif typ == "plane":
        size = float(g.get("size", 1.0))
        sw = max(4, int(proj.world_scale(size) / 2))
        draw.rectangle([px - sw, py - sw, px + sw, py + sw], fill=base_color)
    elif typ == "light":
        light = e.get("light", {}) or {}
        color = light.get("color")
        if not color and light.get("color_temperature_k"):
            color = kelvin_to_rgb(light["color_temperature_k"])
        color = norm_color(color, (1, 1, 1))
        power = float(light.get("power", 500))
        power = apply_events_power(e, power, t_now)
        radius = int(min(120, max(20, power / 8)))
        # Draw a soft glow onto the blur layer.
        glow = Image.new("RGBA", (radius * 2, radius * 2), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        for i in range(radius, 0, -2):
            alpha = int(180 * (1 - i / radius) ** 2)
            gd.ellipse([radius - i, radius - i, radius + i, radius + i],
                       fill=(color[0], color[1], color[2], alpha))
        blur_layer.paste(glow, (px - radius, py - radius), glow)
        # Small bright dot
        draw.ellipse([px - 4, py - 4, px + 4, py + 4], fill=color)
    elif typ == "camera":
        rot = t.get("rotation", [0, 0, 0])
        yaw = math.radians(rot[2] if rot else 0)
        size = 12
        pts = [
            (px + size * math.cos(yaw), py - size * math.sin(yaw)),
            (px + size * math.cos(yaw + 2.5), py - size * math.sin(yaw + 2.5)),
            (px + size * math.cos(yaw - 2.5), py - size * math.sin(yaw - 2.5)),
        ]
        draw.polygon(pts, fill=(255, 220, 100), outline=(255, 255, 255))


def apply_events_position(e, base_pos, t_now):
    events = e.get("_events", [])
    pos = list(base_pos)
    for ev in events:
        if ev.get("time", 0) <= t_now and "position" in (ev.get("action") or {}):
            pos = list(ev["action"]["position"])
    return pos


def apply_events_power(e, base_power, t_now):
    events = e.get("_events", [])
    power = base_power
    for ev in events:
        if ev.get("time", 0) <= t_now and "energy" in (ev.get("action") or {}):
            power = float(ev["action"]["energy"])
    return power


# ─────────────────────────────────────────────────────────────────────────
# Compositing (numpy-free, using PIL only)
# ─────────────────────────────────────────────────────────────────────────
def apply_vignette(img, strength):
    if not strength:
        return img
    w, h = img.size
    # Build a radial alpha mask as an "L" image using ImageDraw + blur.
    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([-w // 4, -h // 4, w + w // 4, h + h // 4], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(w // 6))
    # Strength: how much of the dark layer to blend in at the corners.
    # Invert mask (so corners = high alpha) and scale by strength*0.6.
    inverted = ImageChops.invert(mask)
    # Multiply by strength factor using .point()
    alpha = inverted.point(lambda v: int(v * float(strength) * 0.6))
    dark = Image.new("RGB", (w, h), (0, 0, 0))
    return Image.composite(dark, img, alpha)


def apply_grain(img, strength):
    if not strength:
        return img
    w, h = img.size
    amount = float(strength)
    if amount <= 0:
        return img
    # Generate per-pixel noise as a single-channel "L" image.
    try:
        noise_l = Image.effect_noise((w, h), int(40 * amount)).convert("L")
    except Exception:
        # Fallback: a flat mid-gray image (no noise) if effect_noise fails.
        return img
    # Build a 3-channel RGB noise image by merging 3 copies of the L channel.
    noise_rgb = Image.merge("RGB", (noise_l, noise_l, noise_l))
    # Compress the noise amplitude around 128 (so it adds +/- brightness
    # without a DC bias). point() with a function applies it to every band.
    def _compress(v):
        return int(128 + (v - 128) * amount * 0.6)
    noise_rgb = noise_rgb.point(_compress)
    # Screen blend: result = 255 - (255 - a) * (255 - b) / 255.
    # Brightens without clipping, stays within [0, 255].
    return ImageChops.screen(img, noise_rgb)


def apply_exposure(img, ev):
    if not ev:
        return img
    factor = 2.0 ** float(ev)
    # point() with a function applies it to every band of the RGB image.
    return img.point(lambda v: min(255, int(v * factor)))


# ─────────────────────────────────────────────────────────────────────────
# Main render loop
# ─────────────────────────────────────────────────────────────────────────
def render(world, out_dir, width, height, fps, duration):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    proj = Projector(world.get("world", {}), width, height)
    aesthetic = (world.get("world", {}) or {}).get("aesthetic", {}) or {}
    ambient = (world.get("world", {}) or {}).get("environment", {}).get("ambient_color", [0.05, 0.05, 0.07])
    ambient_rgb = norm_color(ambient, 0.05)

    events_by_target = {}
    for ev in world.get("events", []):
        events_by_target.setdefault(ev.get("target"), []).append(ev)
    for e in world.get("entities", []):
        e["_events"] = events_by_target.get(e.get("id"), [])

    room = None
    for e in world.get("entities", []):
        if e.get("type") == "room":
            room = e
            break

    n_frames = max(1, int(duration * fps))
    frames = []

    for i in range(n_frames):
        t_now = i / fps
        frame = Image.new("RGB", (width, height), ambient_rgb)
        draw = ImageDraw.Draw(frame, "RGBA")
        blur_layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))

        if room:
            dims = room.get("geometry", {}).get("dimensions", [10, 10, 3])
            tile = (room.get("metadata", {}) or {}).get("checker_tile_size", 0.6)
            draw_checkerboard(draw, proj, dims, tile)
            draw_room_outline(draw, proj, dims)

        ents = sorted(
            [e for e in world.get("entities", []) if e.get("type") != "room"],
            key=lambda e: (e.get("transform", {}) or {}).get("position", [0, 0, 0])[2] if len((e.get("transform", {}) or {}).get("position", [0, 0, 0])) >= 3 else 0,
        )
        for e in ents:
            draw_entity(draw, proj, e, t_now, frame, blur_layer)

        glow_rgb = blur_layer.filter(ImageFilter.GaussianBlur(8))
        frame = Image.alpha_composite(frame.convert("RGBA"), glow_rgb).convert("RGB")

        draw = ImageDraw.Draw(frame)
        draw.rectangle([10, 10, 360, 70], fill=(0, 0, 0))
        draw.text((20, 18), "Wallermax H1 — preview render", fill=(255, 255, 255))
        draw.text((20, 38), f"t = {t_now:5.2f}s   frame {i+1}/{n_frames}", fill=(200, 200, 200))
        draw.text((20, 54), f"entities: {len(world.get('entities', []))}   provider: fallback", fill=(160, 160, 160))

        frame = apply_exposure(frame, aesthetic.get("exposure_ev"))
        frame = apply_vignette(frame, aesthetic.get("vignette"))
        frame = apply_grain(frame, aesthetic.get("grain"))

        frames.append(frame)

    poster_path = out_dir / "poster.png"
    frames[0].save(poster_path)

    mp4_path = out_dir / "render.mp4"
    pipe_cmd = _build_ffmpeg_command(mp4_path, width, height, fps)
    print(f"WALLERMAX_FALLBACK_FFMPEG: {' '.join(pipe_cmd)}")
    proc = subprocess.Popen(pipe_cmd, stdin=subprocess.PIPE)
    try:
        for f in frames:
            proc.stdin.write(f.tobytes())
        proc.stdin.close()
        proc.wait()
    except BrokenPipeError:
        # ffmpeg died before we finished writing. Capture its stderr so we
        # can show the user a useful error message instead of a bare traceback.
        proc.wait()
        # Re-run with stderr captured so we can include the actual ffmpeg error.
        probe = subprocess.run(pipe_cmd, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        err = probe.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(
            f"ffmpeg failed to encode the MP4.\n"
            f"Command: {' '.join(pipe_cmd)}\n"
            f"ffmpeg stderr:\n{err}\n"
            f"Hint: this usually means the ffmpeg build is missing an encoder. "
            f"Install a build that includes the encoder listed above (e.g. from "
            f"https://ffmpeg.org/download.html — the 'essentials' or 'full' build)."
        )
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg exited with code {proc.returncode}. The MP4 was not produced."
        )

    for e in world.get("entities", []):
        e.pop("_events", None)

    print(f"WALLERMAX_FALLBACK_POSTER: {poster_path}")
    print(f"WALLERMAX_FALLBACK_RENDER: {mp4_path}")
    return mp4_path, poster_path


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print("Usage: fallback_renderer.py world.json output_dir [width] [height] [fps] [duration]")
        sys.exit(1)
    world_path = Path(args[0]).resolve()
    out_dir = Path(args[1]).resolve()
    world = json.loads(world_path.read_text(encoding="utf-8"))
    render_block = (world.get("world", {}) or {}).get("render", {}) or {}
    width = int(args[2]) if len(args) > 2 else int(render_block.get("width", 1280))
    height = int(args[3]) if len(args) > 3 else int(render_block.get("height", 720))
    fps = int(args[4]) if len(args) > 4 else int(render_block.get("fps", 30))
    duration = float(args[5]) if len(args) > 5 else float(render_block.get("duration", 8))
    render(world, out_dir, width, height, fps, duration)


if __name__ == "__main__":
    main()
