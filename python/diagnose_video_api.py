"""
Wallermax H1 — Blender 5.x Video Output API diagnostic.

Run this script in Blender to see exactly what the `scene.render.outputs`
API looks like in your build. This will tell us why the native video
output doesn't work and how to fix it.

Usage:
    blender -b --python diagnose_video_api.py
"""

import bpy

print("=" * 70)
print("BLENDER VIDEO OUTPUT API DIAGNOSTIC")
print("=" * 70)
print(f"Blender version: {bpy.app.version_string}")
print(f"Blender build: {bpy.app.build_date} (hash {bpy.app.build_hash})")
print()

# ── 1. Check scene.render.image_settings.file_format ─────────────────
print("─" * 70)
print("1. scene.render.image_settings.file_format")
print("─" * 70)
try:
    current = bpy.context.scene.render.image_settings.file_format
    print(f"   Current value: {current!r}")
    # Try to list valid enum values
    try:
        # In Blender, enum properties expose their items via the RNA
        prop = bpy.context.scene.render.image_settings.bl_rna.properties["file_format"]
        if prop.type == "ENUM":
            items = [item.identifier for item in prop.enum_items]
            print(f"   Valid enum values ({len(items)}): {items}")
            if "FFMPEG" in items:
                print("   ✅ 'FFMPEG' IS in the list — classic API should work!")
            else:
                print("   ❌ 'FFMPEG' is NOT in the list — classic API won't work.")
    except Exception as e:
        print(f"   Could not enumerate enum items: {e}")
except Exception as e:
    print(f"   Error: {e}")
print()

# ── 2. Check scene.render.ffmpeg ──────────────────────────────────────
print("─" * 70)
print("2. scene.render.ffmpeg")
print("─" * 70)
try:
    ff = bpy.context.scene.render.ffmpeg
    print(f"   Type: {type(ff)}")
    print(f"   Attributes: {[a for a in dir(ff) if not a.startswith('_')]}")
    for attr in ["format", "codec", "constant_rate_factor", "video_bitrate",
                  "audio_codec", "audio_bitrate", "muxrate", "packetsize",
                  "gopsize", "maxrate", "minrate", "buffersize"]:
        val = getattr(ff, attr, "<not found>")
        print(f"   ffmpeg.{attr} = {val!r}")
except Exception as e:
    print(f"   Error: {e}")
print()

# ── 3. Check scene.render.outputs ────────────────────────────────────
print("─" * 70)
print("3. scene.render.outputs")
print("─" * 70)
try:
    outputs = bpy.context.scene.render.outputs
    print(f"   Type: {type(outputs)}")
    print(f"   Length: {len(outputs)}")
    for i, o in enumerate(outputs):
        print(f"   ── Output[{i}] ──")
        print(f"      name: {o.name!r}")
        # List ALL attributes
        attrs = [a for a in dir(o) if not a.startswith("_") and not callable(getattr(o, a, None))]
        print(f"      attributes: {attrs}")
        for attr in attrs:
            try:
                val = getattr(o, attr)
                print(f"      {attr}: {val!r}")
            except Exception as e:
                print(f"      {attr}: <error: {e}>")
        # Check if 'format' sub-object exists
        if hasattr(o, "format"):
            fmt = o.format
            print(f"      ── output.format ──")
            fmt_attrs = [a for a in dir(fmt) if not a.startswith("_") and not callable(getattr(fmt, a, None))]
            print(f"         format attributes: {fmt_attrs}")
            for attr in fmt_attrs:
                try:
                    val = getattr(fmt, attr)
                    print(f"         format.{attr}: {val!r}")
                except Exception as e:
                    print(f"         format.{attr}: <error: {e}>")
except AttributeError as e:
    print(f"   ❌ scene.render.outputs does NOT exist in this build: {e}")
    print("   This means the Output Slots API is not available.")
    print("   The PNG+ffmpeg fallback is the only option.")
except Exception as e:
    print(f"   Error: {e}")
print()

# ── 4. Check if RenderOutput RNA type has 'file_format' enum ──────────
print("─" * 70)
print("4. RenderOutput RNA type introspection")
print("─" * 70)
try:
    # Get the RNA type of a RenderOutput
    outputs = bpy.context.scene.render.outputs
    if len(outputs) > 0:
        rna_type = outputs[0].bl_rna
        print(f"   RNA type identifier: {rna_type.identifier}")
        props = [p.identifier for p in rna_type.properties]
        print(f"   All properties ({len(props)}): {props}")
        # Check if 'file_format' is an enum and list its values
        if "file_format" in props:
            ff_prop = rna_type.properties["file_format"]
            if ff_prop.type == "ENUM":
                items = [item.identifier for item in ff_prop.enum_items]
                print(f"   file_format enum values ({len(items)}): {items}")
                if "FFMPEG" in items:
                    print("   ✅ 'FFMPEG' IS valid for RenderOutput.file_format!")
                else:
                    print("   ❌ 'FFMPEG' is NOT valid for RenderOutput.file_format.")
            else:
                print(f"   file_format type: {ff_prop.type} (not an enum)")
        else:
            print("   ❌ 'file_format' property does not exist on RenderOutput")
except Exception as e:
    print(f"   Error: {e}")
print()

# ── 5. Try to create a new output with FFMPEG ─────────────────────────
print("─" * 70)
print("5. Attempt to create an FFMPEG output")
print("─" * 70)
try:
    outputs = bpy.context.scene.render.outputs
    # Try creating a new output
    try:
        new_out = outputs.new("TestVideo")
        print(f"   Created output: {new_out.name!r}")
        # Try setting file_format to FFMPEG
        try:
            new_out.file_format = "FFMPEG"
            actual = new_out.file_format
            if actual == "FFMPEG":
                print(f"   ✅ file_format set to FFMPEG successfully!")
                # Try to configure the video codec
                if hasattr(new_out, "format"):
                    fmt = new_out.format
                    print(f"   format object: {fmt}")
                    if hasattr(fmt, "video_codec"):
                        # List valid video codecs
                        vc_prop = fmt.bl_rna.properties["video_codec"]
                        if vc_prop.type == "ENUM":
                            vc_items = [item.identifier for item in vc_prop.enum_items]
                            print(f"   Valid video_codec values: {vc_items}")
                    else:
                        print("   ❌ format has no 'video_codec' attribute")
                else:
                    print("   ❌ output has no 'format' attribute")
            else:
                print(f"   ❌ file_format assignment silently failed — stayed as {actual!r}")
        except (TypeError, ValueError) as e:
            print(f"   ❌ file_format = 'FFMPEG' raised: {e}")
        # Clean up
        try:
            outputs.remove(new_out)
            print("   Cleaned up test output.")
        except Exception:
            pass
    except Exception as e:
        print(f"   ❌ Could not create new output: {e}")
except Exception as e:
    print(f"   ❌ scene.render.outputs not available: {e}")
print()

# ── 6. Summary ────────────────────────────────────────────────────────
print("=" * 70)
print("SUMMARY")
print("=" * 70)
print("""
Based on the diagnostics above:

1. If 'FFMPEG' IS in image_settings.file_format enum:
   → The classic API should work. The issue is elsewhere.

2. If scene.render.outputs exists AND file_format='FFMPEG' works on it:
   → The Blender 5.x native API should work.
   → Check if 'format.video_codec' exists and accepts 'H264'.

3. If neither works:
   → Blender 5.2 in this build does not support native video output.
   → The PNG+ffmpeg fallback is the correct and only option.
   → This is a known limitation of pre-release/development builds.
""")
print("Diagnostic complete.")
