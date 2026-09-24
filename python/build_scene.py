"""
Wallermax H1 — Blender scene compiler.

Reads a Wallermax World Model JSON file and compiles it into a .blend + MP4.

Improvements over World Compiler v2/v3:
  - Per-entity confidence & provenance custom properties (preserved in .blend)
  - Color-temperature -> RGB conversion for lights (kelvin_to_rgb)
  - Aesthetic block drives world ambient color, vignette, bloom & exposure
  - Camera supports look_at, target tracking, orbit, dolly & crane behaviors
  - Materials support patterns (checker / noise / gradient / brick),
    emission, alpha, IOR and optional texture image maps
  - Events support energy, location, rotation, color and visibility keyframes
  - Frame range, resolution, fps and engine are honored from world.render
  - Gracefully handles missing optional fields (no crashes on minimal inputs)
  - Deterministic: same input -> same output, no random ops

Cinematic quality patch (v1.2.0):
  - world.render.quality presets: preview | standard | cinematic
    (cinematic = motion blur, soft shadows, SSR/raytracing, GTAO, 128
     EEVEE TAA samples or 128+ Cycles samples with OpenImageDenoise,
     AgX color management, high-quality H.264 CRF)
  - world.environment.hdri (path/rotation_z) and world.environment.sky
    (Nishita physical sky with an auto-created sun light for EEVEE)
  - world.aesthetic: the vignette now actually applies; film grain
    (seeded, animated per frame); chromatic aberration; color-temperature
    grade; bloom via the engine-independent Glare compositor node
  - Camera behaviors: spline_path (waypoints -> Bezier -> Follow Path
    with cinematic easing), zoom_in / zoom_out (animated focal length),
    camera.dof_autofocus (focus_object tracks the target)
  - Entities of type "model" (or geometry.file) import
    .glb/.gltf/.obj/.fbx/.ply assets
  - Optional world.render.postprocess: subtle sharpen/grade pass via ffmpeg

Invocation (Blender >= 3.6):
    blender -b --python build_scene.py -- world.json output_dir
"""

import bpy
import json
import math
import os
import random
import sys
from pathlib import Path
from mathutils import Vector

# Set by compile_world() to the absolute path of the job's upload directory.
# Used by make_material() to resolve texture_image / normal_image / roughness_image.
_CURRENT_UPLOAD_DIR = None



# ─────────────────────────────────────────────────────────────────────────
# CLI helpers
# ─────────────────────────────────────────────────────────────────────────
def cli_args():
    a = sys.argv
    if "--" not in a:
        raise RuntimeError("Arguments required after --")
    return a[a.index("--") + 1:]


def clear_scene():
    # Wipe everything: objects, meshes, materials, lights, cameras, worlds.
    # Use the data API directly (not bpy.ops) so we don't depend on a valid
    # active-object context, which can be missing on a fresh Blender start.
    # This is more robust across Blender 3.x / 4.x than the bpy.ops version.
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.lights,
                       bpy.data.cameras, bpy.data.images, bpy.data.worlds,
                       bpy.data.textures, bpy.data.node_groups):
        for item in list(collection):
            try:
                collection.remove(item)
            except (RuntimeError, ReferenceError):
                # Some items (e.g. node_groups used by Blender internally)
                # may refuse to be removed; skip them.
                pass


# ─────────────────────────────────────────────────────────────────────────
# Math / color helpers
# ─────────────────────────────────────────────────────────────────────────
def v(x):
    return Vector(x or [0.0, 0.0, 0.0])


def apply_transform(o, t):
    if not t:
        return
    o.location = v(t.get("position"))
    o.rotation_euler = [math.radians(float(x)) for x in t.get("rotation", [0, 0, 0])]
    o.scale = v(t.get("scale", [1, 1, 1]))


def kelvin_to_rgb(kelvin):
    """Approximate sRGB color for a blackbody at the given color temperature."""
    k = max(1000.0, min(40000.0, float(kelvin))) / 100.0
    if k <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(k) - 161.1195681661
        b = 0.0 if k <= 19 else 138.5177312231 * math.log(k - 10) - 305.0447927307
    else:
        r = 329.698727446 * ((k - 60) ** -0.1332047592)
        g = 288.1221695283 * ((k - 60) ** -0.0755148492)
        b = 255.0
    return [max(0.0, min(1.0, x / 255.0)) for x in (r, g, b)]


def norm_color(c, default=0.8):
    if not c:
        return [default, default, default, 1.0]
    if len(c) == 3:
        return [float(c[0]), float(c[1]), float(c[2]), 1.0]
    if len(c) == 4:
        return [float(x) for x in c]
    return [default, default, default, 1.0]


# ─────────────────────────────────────────────────────────────────────────
# Materials
# ─────────────────────────────────────────────────────────────────────────

def resolve_texture_path(name, upload_dir=None):
    """Resolve a texture filename/relative path to an absolute path.

    Tries in order:
      1. If `name` is already absolute and exists -> return it.
      2. If `upload_dir` is given, join upload_dir/name and check.
      3. Walk job_dir (out_dir) recursively for a file with that basename.
      4. As last resort, return `name` as-is (let bpy.data.images.load fail
         with a clear error if the file truly doesn't exist).
    """
    if not name or not isinstance(name, str):
        return name
    p = Path(name)
    if p.is_absolute() and p.exists():
        return str(p)
    if upload_dir is not None:
        cand = Path(upload_dir) / name
        if cand.exists():
            return str(cand.resolve())
        cand2 = Path(upload_dir) / p.name
        if cand2.exists():
            return str(cand2.resolve())
    base = p.name
    search_roots = []
    if upload_dir is not None:
        search_roots.append(Path(upload_dir))
        search_roots.append(Path(upload_dir) / "_uploads")
    for root in search_roots:
        if not root.exists():
            continue
        for hit in root.rglob(base):
            return str(hit.resolve())
    print(f"WALLERMAX_TEXTURE_RESOLVE_FAIL: '{name}' not found in upload_dir={upload_dir}")
    return name

def _get_material_node_tree(mat):
    """Return the Material's shader node tree, or None if unavailable.

    In Blender 5.x, `material.use_nodes = True` is deprecated. The tree is
    accessed via `material.node_tree` after enabling nodes, but enabling
    nodes itself can fail on some builds.
    """
    try:
        mat.use_nodes = True
    except (AttributeError, TypeError, KeyError):
        pass
    try:
        if hasattr(mat, "node_tree") and mat.node_tree is not None:
            return mat.node_tree
    except (AttributeError, TypeError):
        pass
    return None




def _get_assets_dir():
    """Return the path to assets/texture_atlas/ relative to this script."""
    return Path(__file__).parent.parent / "assets" / "texture_atlas"


def extract_atlas_tile(atlas_name, row, col, tile_size=102):
    """Extract a single tile from a predefined texture atlas.

    Args:
      atlas_name: str — name of the atlas (e.g. "room-1")
      row: int — row index (0-indexed, top to bottom)
      col: int — column index (0-indexed, left to right)
      tile_size: int — size of each tile in pixels (default 102 for 1024/10)

    Returns:
      bpy.types.Image — a new image containing just the extracted tile,
                        with sRGB color space.

    Raises:
      FileNotFoundError if the atlas file does not exist.
      ValueError if the coordinates are out of bounds.
    """
    assets_dir = _get_assets_dir()
    atlas_path = assets_dir / f"{atlas_name}.png"
    if not atlas_path.exists():
        raise FileNotFoundError(f"Atlas '{atlas_name}' not found at {atlas_path}")

    # Load the source atlas
    atlas_img = bpy.data.images.load(str(atlas_path), check_existing=True)
    atlas_w, atlas_h = atlas_img.size[0], atlas_img.size[1]

    # Validate coordinates
    x_start = col * tile_size
    y_start = row * tile_size
    if x_start + tile_size > atlas_w or y_start + tile_size > atlas_h:
        raise ValueError(
            f"Tile ({row},{col}) out of bounds for atlas '{atlas_name}' "
            f"({atlas_w}x{atlas_h}, tile_size={tile_size})"
        )

    # Create a new image for the tile
    tile_img = bpy.data.images.new(
        f"{atlas_name}_tile_{row}_{col}",
        width=tile_size,
        height=tile_size,
        alpha=True,
    )
    tile_img.colorspace_settings.name = "sRGB"

    # Extract pixels from the atlas.
    # bpy.data.images.pixels is a flat array of RGBA floats (0-1), row by row,
    # top to bottom.
    atlas_pixels = list(atlas_img.pixels)
    tile_pixels = []
    for y in range(y_start, y_start + tile_size):
        for x in range(x_start, x_start + tile_size):
            src_idx = (y * atlas_w + x) * 4
            tile_pixels.extend(atlas_pixels[src_idx:src_idx + 4])

    # IMPORTANT: Use slice assignment ([:] =) instead of direct assignment.
    # In Blender 5.x, `image.pixels = list` may NOT propagate to the image
    # buffer in the viewport. Slice assignment forces the copy.
    # Also: convert to a tuple to ensure the buffer is updated atomically.
    tile_img.pixels[:] = tile_pixels
    # Mark the image as changed so the viewport refreshes
    try:
        tile_img.update()
    except Exception:
        pass
    # pack() saves the image to memory so it survives file saves and renders
    try:
        tile_img.pack()
    except Exception as exc:
        print(f"WALLERMAX_ATLAS_PACK_WARN: '{atlas_name}_tile_{row}_{col}' - {exc}")
    print(f"WALLERMAX_ATLAS_EXTRACTED: atlas='{atlas_name}' tile=({row},{col}) "
          f"size={tile_size}x{tile_size}")
    return tile_img


def make_material(name, spec):
    """Build a Principled BSDF material from a Wallermax material block.

    Defensive: if `spec` is a string (some LLMs emit "material": "wood.jpg"
    instead of {"texture_image": "wood.jpg"}), coerce it to a dict.
    """
    if isinstance(spec, str):
        # Treat a bare string as a texture_image filename.
        spec = {"texture_image": spec}
    elif not isinstance(spec, dict):
        spec = {}
    else:
        spec = spec or {}
    mat = bpy.data.materials.new(name)
    nt = _get_material_node_tree(mat)
    if nt is None:
        # No node tree available — set the legacy diffuse_color directly
        # so the material at least has *some* color (no shaders, but the
        # render will still work).
        print(f"WALLERMAX_MATERIAL_NO_NODES: '{name}' — using legacy diffuse_color")
        mat.diffuse_color = norm_color(spec.get("base_color"), 0.8)
        return mat
    nt.nodes.clear()

    out_node = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out_node.inputs["Surface"])

    base_color = norm_color(spec.get("base_color"), 0.8)
    bsdf.inputs["Base Color"].default_value = base_color
    bsdf.inputs["Roughness"].default_value = float(spec.get("roughness", 0.5))
    bsdf.inputs["Metallic"].default_value = float(spec.get("metallic", 0.0))

    if "IOR" in bsdf.inputs:
        bsdf.inputs["IOR"].default_value = float(spec.get("ior", 1.45))
    if "Alpha" in bsdf.inputs:
        bsdf.inputs["Alpha"].default_value = float(spec.get("alpha", 1.0))

    emission = spec.get("emission")
    if emission:
        em_color = norm_color(emission, 0.0)
        if "Emission Color" in bsdf.inputs:  # Blender 4.x
            bsdf.inputs["Emission Color"].default_value = em_color
        elif "Emission" in bsdf.inputs:  # Blender 3.x
            bsdf.inputs["Emission"].default_value = em_color
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = float(spec.get("emission_strength", 1.0))

    pattern = spec.get("pattern", "solid")
    if pattern == "checker":
        tex = nt.nodes.new("ShaderNodeTexChecker")
        tex.inputs["Color1"].default_value = base_color
        tex.inputs["Color2"].default_value = [max(0.0, 1.0 - base_color[0]),
                                              max(0.0, 1.0 - base_color[1]),
                                              max(0.0, 1.0 - base_color[2]), 1.0]
        tex.inputs["Scale"].default_value = float(spec.get("pattern_scale", 4.0))
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    elif pattern == "noise":
        tex = nt.nodes.new("ShaderNodeTexNoise")
        tex.inputs["Scale"].default_value = float(spec.get("pattern_scale", 5.0))
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        nt.links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    elif pattern == "gradient":
        tex = nt.nodes.new("ShaderNodeTexGradient")
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        nt.links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    elif pattern == "brick":
        tex = nt.nodes.new("ShaderNodeTexBrick")
        tex.inputs["Color1"].default_value = base_color
        tex.inputs["Color2"].default_value = [base_color[0] * 0.8,
                                               base_color[1] * 0.8,
                                               base_color[2] * 0.8, 1.0]
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

    # Image-based PBR textures (overrides any procedural pattern above).
    texture_image = spec.get("texture_image")
    if texture_image:
        # Check if it's an atlas reference: "atlas:room-1:3,5"
        if isinstance(texture_image, str) and texture_image.startswith("atlas:"):
            try:
                parts = texture_image.split(":")
                atlas_name = parts[1]
                row_str, col_str = parts[2].split(",")
                row, col = int(row_str), int(col_str)
                albedo_img = extract_atlas_tile(atlas_name, row, col)
                albedo_img.colorspace_settings.name = "sRGB"
            except Exception as exc:
                print(f"WALLERMAX_ATLAS_EXTRACT_FAIL: '{texture_image}' - {exc}")
                albedo_img = None
        else:
            upload_dir = _CURRENT_UPLOAD_DIR
            tex_path = resolve_texture_path(texture_image, upload_dir)
            try:
                albedo_img = bpy.data.images.load(tex_path, check_existing=True)
                albedo_img.colorspace_settings.name = "sRGB"
            except Exception as exc:
                print(f"WALLERMAX_TEXTURE_LOAD_FAIL: '{tex_path}' - {exc}")
                albedo_img = None

        if albedo_img is not None:
            scale = float(spec.get("pattern_scale", 1.0))
            uv_node = nt.nodes.new("ShaderNodeUVMap")
            vec_out = uv_node.outputs["UV"]
            if scale != 1.0:
                mapping = nt.nodes.new("ShaderNodeMapping")
                # Set Scale via individual indices (more reliable than tuple assignment)
                mapping.inputs["Scale"].default_value[0] = scale
                mapping.inputs["Scale"].default_value[1] = scale
                mapping.inputs["Scale"].default_value[2] = 1.0
                nt.links.new(vec_out, mapping.inputs["Vector"])
                vec_out = mapping.outputs["Vector"]

            albedo_tex = nt.nodes.new("ShaderNodeTexImage")
            albedo_tex.image = albedo_img
            albedo_tex.interpolation = "Smart"
            # Explicitly set extension to REPEAT for tiling
            try:
                albedo_tex.extension = "REPEAT"
            except Exception:
                pass
            nt.links.new(vec_out, albedo_tex.inputs["Vector"])
            nt.links.new(albedo_tex.outputs["Color"], bsdf.inputs["Base Color"])

            normal_image = spec.get("normal_image")
            if normal_image:
                try:
                    nrm_img = bpy.data.images.load(
                        resolve_texture_path(normal_image, upload_dir),
                        check_existing=True
                    )
                    nrm_img.colorspace_settings.name = "Non-Color"
                    nrm_tex = nt.nodes.new("ShaderNodeTexImage")
                    nrm_tex.image = nrm_img
                    nt.links.new(vec_out, nrm_tex.inputs["Vector"])
                    nrm_map = nt.nodes.new("ShaderNodeNormalMap")
                    nrm_map.inputs["Strength"].default_value = float(spec.get("normal_strength", 1.0))
                    nt.links.new(nrm_tex.outputs["Color"], nrm_map.inputs["Color"])
                    nt.links.new(nrm_map.outputs["Normal"], bsdf.inputs["Normal"])
                except Exception as exc:
                    print(f"WALLERMAX_NORMAL_LOAD_FAIL: '{normal_image}' - {exc}")

            roughness_image = spec.get("roughness_image")
            if roughness_image:
                try:
                    rgh_img = bpy.data.images.load(
                        resolve_texture_path(roughness_image, upload_dir),
                        check_existing=True
                    )
                    rgh_img.colorspace_settings.name = "Non-Color"
                    rgh_tex = nt.nodes.new("ShaderNodeTexImage")
                    rgh_tex.image = rgh_img
                    nt.links.new(vec_out, rgh_tex.inputs["Vector"])
                    nt.links.new(rgh_tex.outputs["Color"], bsdf.inputs["Roughness"])
                except Exception as exc:
                    print(f"WALLERMAX_ROUGHNESS_LOAD_FAIL: '{roughness_image}' - {exc}")

            print(f"WALLERMAX_TEXTURE_APPLIED: '{name}' albedo='{texture_image}' scale={scale}")

    if mat.blend_method and float(spec.get("alpha", 1.0)) < 1.0:
        mat.blend_method = "BLEND"
    return mat


def make_checker_material(name, tile=0.5, plane_size=None):
    """Create a black-and-white checker material.

    Args:
      name: material name.
      tile: desired cell size in meters (e.g. 0.25 = 25cm cells).
      plane_size: the size of the plane this material will be applied to,
                  in meters. If provided, the checker Scale is computed
                  so that cells are exactly `tile` meters on that plane.
                  If None, Scale = 1/tile (works for unit-size planes).
    """
    mat = bpy.data.materials.new(name)
    nt = _get_material_node_tree(mat)
    if nt is None:
        # No node tree available — fall back to a flat white color.
        print(f"WALLERMAX_MATERIAL_NO_NODES: '{name}' — using legacy diffuse_color")
        mat.diffuse_color = (0.5, 0.5, 0.5, 1.0)
        return mat
    nt.nodes.clear()
    out_node = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    tex = nt.nodes.new("ShaderNodeTexChecker")
    tex.inputs["Color1"].default_value = (1.0, 1.0, 1.0, 1.0)
    tex.inputs["Color2"].default_value = (0.0, 0.0, 0.0, 1.0)
    # The checker texture's Scale controls how many times the pattern
    # repeats across the UV range [0,1]. A plane of size S has UVs from
    # 0 to 1, so to get cells of `tile` meters we need:
    #   Scale = S / tile
    # (e.g. S=10, tile=0.25 → Scale=40 → 40 cells per row).
    if plane_size is not None and plane_size > 0:
        scale = float(plane_size) / max(float(tile), 0.001)
    else:
        scale = 1.0 / max(float(tile), 0.001)
    tex.inputs["Scale"].default_value = scale
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(bsdf.outputs["BSDF"], out_node.inputs["Surface"])
    bsdf.inputs["Roughness"].default_value = 0.55
    print(f"WALLERMAX_CHECKER_MATERIAL: '{name}' tile={tile} plane_size={plane_size} scale={scale}")
    return mat


# ─────────────────────────────────────────────────────────────────────────
# Primitives
# ─────────────────────────────────────────────────────────────────────────
def add_box(name, dims, loc, mat=None):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.object
    o.name = name
    if dims:
        o.dimensions = Vector(dims)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat:
        o.data.materials.append(mat)
    return o


def add_sphere(name, radius, loc, mat=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24,
                                          radius=float(radius), location=loc)
    o = bpy.context.object
    o.name = name
    if mat:
        o.data.materials.append(mat)
    # Shade smooth — use the data API to avoid context issues in background mode.
    for poly in o.data.polygons:
        poly.use_smooth = True
    return o


def add_cylinder(name, radius, depth, loc, mat=None):
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=float(radius),
                                        depth=float(depth), location=loc)
    o = bpy.context.object
    o.name = name
    if mat:
        o.data.materials.append(mat)
    return o


def add_plane(name, size, loc, mat=None):
    bpy.ops.mesh.primitive_plane_add(size=float(size), location=loc)
    o = bpy.context.object
    o.name = name
    if mat:
        o.data.materials.append(mat)
    return o


def import_model(e, g, pos, mat=None):
    """Import an external 3D model (.glb/.gltf, .obj, .fbx, .ply).

    Returns the imported root object (an Empty parent when the import
    produced multiple objects, so entity transforms apply to the whole
    group), or None when the import failed (the caller falls back to a
    placeholder). The model file is resolved like textures (upload dir
    walk included), so uploaded assets just work.

    Import operators select the imported objects, which is how we get a
    handle on them in background mode.
    """
    f = g.get("file") or g.get("path") or (e.get("metadata", {}) or {}).get("file")
    if not f:
        return None
    resolved = resolve_texture_path(str(f), _CURRENT_UPLOAD_DIR)
    p = Path(str(resolved))
    if not p.exists():
        print(f"WALLERMAX_MODEL_SKIP: '{f}' not found (resolved: {resolved})")
        return None
    ext = p.suffix.lower()
    try:
        if ext in (".glb", ".gltf"):
            try:
                bpy.ops.preferences.addon_enable(module="io_scene_gltf2")
            except (RuntimeError, AttributeError):
                pass
            bpy.ops.import_scene.gltf(filepath=str(p))
        elif ext == ".obj":
            try:
                bpy.ops.wm.obj_import(filepath=str(p))  # Blender 4.1+
            except (RuntimeError, AttributeError):
                bpy.ops.import_scene.obj(filepath=str(p))  # Blender 3.x
        elif ext == ".fbx":
            try:
                bpy.ops.preferences.addon_enable(module="io_scene_fbx")
            except (RuntimeError, AttributeError):
                pass
            bpy.ops.import_scene.fbx(filepath=str(p))
        elif ext == ".ply":
            try:
                bpy.ops.wm.ply_import(filepath=str(p))
            except (RuntimeError, AttributeError):
                bpy.ops.import_mesh.ply(filepath=str(p))
        else:
            print(f"WALLERMAX_MODEL_SKIP: unsupported format '{ext}'")
            return None
    except (RuntimeError, AttributeError) as exc:
        print(f"WALLERMAX_MODEL_FAIL: '{p.name}' - {exc}")
        return None

    sel = list(bpy.context.selected_objects)
    if not sel:
        print(f"WALLERMAX_MODEL_FAIL: import produced no objects ('{p.name}')")
        return None

    # Optional material override on every imported mesh.
    if mat is not None:
        for ob in sel:
            if ob.type == "MESH" and getattr(ob, "data", None) is not None:
                try:
                    ob.data.materials.clear()
                    ob.data.materials.append(mat)
                except (RuntimeError, AttributeError):
                    pass

    if len(sel) == 1:
        o = sel[0]
        o.name = e["id"]
        print(f"WALLERMAX_MODEL: '{p.name}' → single object '{o.name}'")
        return o

    # Multi-object import: parent everything under one Empty root so the
    # entity transform moves the whole asset. The root starts at the world
    # origin — children keep their import positions via
    # matrix_parent_inverse — so apply_transform can position the group
    # exactly like any primitive.
    root = add_empty(e["id"] + "_root", [0, 0, 0])
    for ob in sel:
        if ob is root:
            continue
        ob.parent = root
        ob.matrix_parent_inverse = root.matrix_world.inverted()
    print(f"WALLERMAX_MODEL: '{p.name}' → {len(sel)} objects under '{root.name}'")
    return root


def build_room(e):
    g = e.get("geometry", {}) or {}
    x, y, z = g.get("dimensions", [10, 10, 3])
    md = e.get("metadata", {}) or {}
    tile = md.get("checker_tile_size", 0.25)
    wall_thickness = md.get("wall_thickness", 0.15)

    # Floor: respect the entity's material if provided (supports PBR textures
    # via metadata.floor_material), otherwise fall back to the checker material.
    # Defensive: some LLMs emit material/floor_material as a bare string instead
    # of an object — coerce to dict so make_material can handle it.
    floor_spec = md.get("floor_material") or (e.get("material") if e.get("type") != "room" else None)
    if isinstance(floor_spec, str):
        floor_spec = {"texture_image": floor_spec}
    if floor_spec and isinstance(floor_spec, dict):
        floor_mat = make_material(e["id"] + "_floor_mat", floor_spec)
    else:
        floor_mat = make_checker_material(e["id"] + "_floor_checker", tile, plane_size=x)
    add_plane("floor", x, [0, 0, 0], floor_mat)

    # Ceiling: a plane flipped upside-down at z. We reuse the floor
    # material for consistency.
    ceiling = add_plane("ceiling", x, [0, 0, z], floor_mat)
    ceiling.rotation_euler = (math.radians(180), 0, 0)

    # Walls: respect metadata.wall_material if provided, otherwise fall back
    # to the solid neutral color. Same defensive coercion as above.
    wall_spec = md.get("wall_material")
    if isinstance(wall_spec, str):
        wall_spec = {"texture_image": wall_spec}
    if wall_spec and isinstance(wall_spec, dict):
        wall_mat = make_material(e["id"] + "_wall_mat", wall_spec)
    else:
        wall_mat = make_material(e["id"] + "_wall", {
            "base_color": [0.7, 0.7, 0.72],
            "roughness": 0.8,
            "metallic": 0.0,
        })
    add_box("wall_back", [x, wall_thickness, z], [0, y / 2, z / 2], wall_mat)
    add_box("wall_front", [x, wall_thickness, z], [0, -y / 2, z / 2], wall_mat)
    add_box("wall_left", [wall_thickness, y, z], [-x / 2, 0, z / 2], wall_mat)
    add_box("wall_right", [wall_thickness, y, z], [x / 2, 0, z / 2], wall_mat)

    print(f"WALLERMAX_ROOM: dims=[{x},{y},{z}] tile={tile} wall_thickness={wall_thickness}")


# ─────────────────────────────────────────────────────────────────────────
# Lights
# ─────────────────────────────────────────────────────────────────────────
def add_light(e):
    spec = e.get("light", {}) or {}
    typ = str(spec.get("type", "POINT")).upper()
    if typ not in {"POINT", "AREA", "SUN", "SPOT"}:
        typ = "POINT"

    data = bpy.data.lights.new(e["id"], typ)
    obj = bpy.data.objects.new(e["id"], data)
    bpy.context.collection.objects.link(obj)
    apply_transform(obj, e.get("transform", {}))

    color = spec.get("color")
    if not color and spec.get("color_temperature_k"):
        color = kelvin_to_rgb(spec["color_temperature_k"])
    data.color = norm_color(color, 1.0)[:3]
    data.energy = float(spec.get("power", 500.0))

    if typ == "AREA":
        data.shape = spec.get("shape", "DISK")
        data.size = float(spec.get("size", 1.0))
    elif typ == "SPOT":
        data.spot_size = math.radians(float(spec.get("beam_angle", 45.0)))
        data.spot_blend = float(spec.get("softness", 0.25))
    return obj


# ─────────────────────────────────────────────────────────────────────────
# Camera
# ─────────────────────────────────────────────────────────────────────────
def add_track_constraint(o, target):
    c = o.constraints.new("TRACK_TO")
    c.target = target
    c.track_axis = "TRACK_NEGATIVE_Z"
    c.up_axis = "UP_Y"


def add_empty(name, location, empty_type="PLAIN_AXES"):
    """Create an Empty object using the data API (no bpy.ops).

    In Blender background mode (-b), bpy.ops.object.empty_add can fail
    because it requires a valid active-object context that doesn't exist.
    The data API (bpy.data.objects.new + collection.link) works in all modes.
    """
    empty = bpy.data.objects.new(name, None)  # None = no mesh data → Empty
    bpy.context.collection.objects.link(empty)
    empty.empty_display_type = empty_type
    empty.location = Vector(location) if not isinstance(location, Vector) else location
    return empty


def add_camera(e, objs):
    spec = e.get("camera", {}) or {}
    data = bpy.data.cameras.new(e["id"])
    obj = bpy.data.objects.new(e["id"], data)
    bpy.context.collection.objects.link(obj)
    bpy.context.scene.camera = obj
    apply_transform(obj, e.get("transform", {}))
    data.lens = float(spec.get("lens", 50.0))

    if "sensor_width" in spec:
        data.sensor_width = float(spec["sensor_width"])
    if spec.get("projection") == "orthographic":
        data.type = "ORTHO"
    if "dof_focus_distance" in spec:
        data.dof.use_dof = True
        data.dof.focus_distance = float(spec["dof_focus_distance"])
        if "dof_fstop" in spec:
            data.dof.aperture_fstop = float(spec["dof_fstop"])

    target_id = spec.get("target")
    target_obj = None
    if target_id and target_id in objs:
        target_obj = objs[target_id]
        add_track_constraint(obj, target_obj)
    elif spec.get("look_at"):
        target_obj = add_empty(e["id"] + "_lookat", spec["look_at"])
        add_track_constraint(obj, target_obj)

    # NEW (v1.2.0): autofocus — bind the DOF focus to the tracked target so
    # the subject stays sharp while the camera moves. Native Blender feature
    # (dof.focus_object takes precedence over focus_distance when set).
    if spec.get("dof_autofocus") and target_obj is not None:
        try:
            data.dof.use_dof = True
            data.dof.focus_object = target_obj
            if "dof_fstop" in spec:
                data.dof.aperture_fstop = float(spec["dof_fstop"])
            else:
                data.dof.aperture_fstop = 2.8  # cinematic default
            print(f"WALLERMAX_DOF_AUTOFOCUS: '{e['id']}' → "
                  f"focus_object='{target_obj.name}' f/{data.dof.aperture_fstop}")
        except (AttributeError, TypeError, RuntimeError) as exc:
            print(f"WALLERMAX_DOF_AUTOFOCUS_SKIP: {exc}")
    return obj


# ─────────────────────────────────────────────────────────────────────────
# Physics & behaviors
# ─────────────────────────────────────────────────────────────────────────
def add_rigid_body(o, spec):
    # Enable the rigidbody world on this scene first (Blender does not
    # create one by default in background mode).
    scene = bpy.context.scene
    if scene.rigidbody_world is None:
        try:
            bpy.ops.rigidbody.world_add()
        except (RuntimeError, AttributeError):
            # If the rigidbody world can't be created (e.g. the Blender build
            # doesn't have the rigidbody module enabled), skip physics for
            # this object. The render will still work; the object just won't
            # be simulated as a rigid body.
            print(f"WALLERMAX_RIGIDBODY_SKIP: cannot create rigidbody world, skipping '{o.name}'")
            return
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    try:
        bpy.ops.rigidbody.object_add()
    except RuntimeError as exc:
        # Rigid-body add can fail if the object already has a rigidbody, or
        # if the world isn't set up. Don't crash the whole render for this.
        print(f"WALLERMAX_RIGIDBODY_SKIP: {exc} (object '{o.name}')")
        o.select_set(False)
        return
    r = o.rigid_body
    r.type = spec.get("type", "ACTIVE")
    r.mass = float(spec.get("mass", 1.0))
    r.restitution = float(spec.get("restitution", 0.6))
    r.friction = float(spec.get("friction", 0.5))
    o.select_set(False)


def apply_behavior(e, o, objs, scene):
    b = e.get("behavior", {}) or {}
    typ = b.get("type")
    if not typ or typ == "static":
        return
    target_id = b.get("target")
    target = objs.get(target_id) if target_id else None

    if typ in {"look_at", "follow"} and target is not None:
        add_track_constraint(o, target)

    elif typ == "orbit" and target is not None:
        # A4 v2: KEEP the TRACK_TO constraint active during orbit.
        # The pivot rotation orbits the camera position around the target,
        # while TRACK_TO keeps the camera oriented toward the look_at point.
        # These are orthogonal — no conflict. Disabling TRACK_TO (as the
        # original A4 patch did) caused the camera to look straight down
        # (default Blender camera orientation = -Z), producing floor-only renders.
        # Create an empty at the target's location using the data API
        # (bpy.ops.object.empty_add fails in background mode on Blender 5.x).
        pivot = add_empty(o.name + "_orbit_pivot", target.location)
        # Parent the object to the pivot. To keep the object's world position
        # unchanged after parenting, we must set matrix_parent_inverse to the
        # inverse of the pivot's world matrix.
        o.parent = pivot
        o.matrix_parent_inverse = pivot.matrix_world.inverted()
        # Keyframe the pivot's Z rotation: start at 0° at frame 1, end at
        # `angle`° at the end frame. Blender will interpolate between them.
        end_frame = max(1, int(float(b.get("duration", scene.frame_end / scene.render.fps)) * scene.render.fps))
        angle_deg = float(b.get("angle", 60.0))
        pivot.rotation_euler = (0, 0, 0)
        pivot.keyframe_insert("rotation_euler", index=2, frame=1)
        pivot.rotation_euler = (0, 0, math.radians(angle_deg))
        pivot.keyframe_insert("rotation_euler", index=2, frame=end_frame)
        # Set the interpolation to BEZIER (default) for smooth motion.
        # Also set extrapolation to LINEAR so the orbit continues past end_frame
        # if the render extends beyond it.
        # Uses _get_action_fcurves to support both Blender 3.x/4.x (action.fcurves)
        # and 5.x (slotted actions: action.layers[].strips[].channelbag.fcurves).
        if pivot.animation_data and pivot.animation_data.action:
            for fc in _get_action_fcurves(pivot.animation_data.action):
                if fc.data_path == "rotation_euler" and fc.array_index == 2:
                    for kp in fc.keyframe_points:
                        kp.interpolation = "BEZIER"
                    fc.extrapolation = "LINEAR"
        print(f"WALLERMAX_BEHAVIOR_ORBIT: object='{o.name}' target='{target.name}' "
              f"pivot='{pivot.name}' angle={angle_deg}° end_frame={end_frame}")

    elif typ == "spline_path" and o is not None:
        _apply_spline_path(e, o, b, scene)

    elif typ in {"dolly_in", "dolly_out", "crane_up", "crane_down",
                 "pan", "tilt"} and o is not None:
        end_frame = max(1, int(float(b.get("duration", scene.frame_end / scene.render.fps)) * scene.render.fps))
        start_loc = o.location.copy()
        start_rot = list(o.rotation_euler)
        # A2 v2: REMOVE TRACK_TO constraint entirely for pan/tilt.
        # The original A2 patch only temporarily disabled it, but re-enabling
        # it caused the constraint to override the rotation_euler keyframes,
        # preventing the pan/tilt from actually animating.
        track_constraints = [c for c in o.constraints if c.type == "TRACK_TO"]
        for c in track_constraints:
            try:
                o.constraints.remove(c)
                print(f"WALLERMAX_TRACK_TO_REMOVED: object='{o.name}' (for {typ} behavior)")
            except Exception as exc:
                print(f"WALLERMAX_TRACK_TO_REMOVE_FAIL: '{o.name}' - {exc}")
                c.influence = 0.0
        o.keyframe_insert("location", frame=1)
        o.keyframe_insert("rotation_euler", frame=1)

        # A3 (v2): dolly_in/out move forward/backward along the camera's view
        # direction. Compute the view direction directly from look_at or target
        # position (more reliable than reading matrix_world, which may be stale
        # after disabling TRACK_TO due to depsgraph caching).
        # crane_up/down move vertically in WORLD space (Z axis).
        # We DO NOT disable the TRACK_TO constraint — we let it continue
        # tracking the target during the dolly. This is the desired behavior:
        # the camera moves forward while keeping the target framed.
        if typ in {"dolly_in", "dolly_out"}:
            distance = float(b.get("distance", 2.0))
            # Determine forward direction in world space.
            cam_spec = e.get("camera", {}) or {}
            forward = None
            # 1. Try camera.look_at
            look_at = cam_spec.get("look_at")
            if look_at and len(look_at) >= 3:
                forward = Vector((float(look_at[0]), float(look_at[1]), float(look_at[2]))) - start_loc
            # 2. Try behavior.target entity position
            if (forward is None or forward.length == 0) and target is not None:
                forward = target.location - start_loc
            # 3. Try camera.target entity (different field)
            target_id_cam = cam_spec.get("target")
            if (forward is None or forward.length == 0) and target_id_cam and target_id_cam in objs:
                forward = objs[target_id_cam].location - start_loc
            # 4. Fallback: read matrix_world (may be stale but better than nothing)
            if forward is None or forward.length == 0:
                try:
                    local_rot = o.matrix_world.to_3x3()
                    forward = local_rot @ Vector((0, 0, -1))
                except Exception:
                    forward = Vector((0, 0, -1))
            # Normalize and apply distance, with sign for in/out.
            if forward.length > 0:
                forward.normalize()
                sign = 1.0 if typ == "dolly_in" else -1.0
                move = forward * (sign * distance)
            else:
                move = Vector((0, 0, 0))
            o.location = start_loc + move
        elif typ in {"crane_up", "crane_down"}:
            distance = float(b.get("distance", 2.0))
            sign = 1.0 if typ == "crane_up" else -1.0
            move = Vector((0, 0, 1)) * (sign * distance)
            o.location = start_loc + move
        elif typ == "pan":
            o.rotation_euler[2] = start_rot[2] + math.radians(float(b.get("angle", 30.0)))
        elif typ == "tilt":
            o.rotation_euler[0] = start_rot[0] + math.radians(float(b.get("angle", 30.0)))
        # NOTE: TRACK_TO was removed (not re-enabled) so our rotation keyframes
        # are the sole controller of camera rotation. This is required for pan/tilt
        # to actually animate.
        o.keyframe_insert("location", frame=end_frame)
        o.keyframe_insert("rotation_euler", frame=end_frame)

    elif typ in {"zoom_in", "zoom_out"} and o is not None:
        _apply_zoom(e, o, b, scene)


def _clamp_end_frame(duration, scene):
    """Behavior duration (seconds) → end frame, clamped to the render range."""
    fps = scene.render.fps
    end_frame = max(1, int(float(duration) * fps))
    if scene.frame_end and scene.frame_end > 1:
        end_frame = min(end_frame, int(scene.frame_end))
    return end_frame


def _set_fcurve_easing(obj, data_path_filter, easing):
    """Apply an easing profile to an object's keyframed fcurves.

    easing ∈ linear | ease_in | ease_out | ease_in_out (default).
    Bezier keyframes with AUTO_CLAMPED handles already produce a smooth
    S-curve (ease-in-out); the easing attribute refines the shape.
    """
    ad = getattr(obj, "animation_data", None)
    if not ad or not ad.action:
        return
    for fc in _get_action_fcurves(ad.action):
        if data_path_filter not in (fc.data_path or ""):
            continue
        for kp in fc.keyframe_points:
            if easing == "linear":
                kp.interpolation = "LINEAR"
            else:
                kp.interpolation = "BEZIER"
                kp.handle_left_type = "AUTO_CLAMPED"
                kp.handle_right_type = "AUTO_CLAMPED"
                try:
                    if easing == "ease_in":
                        kp.easing = "EASE_IN"
                    elif easing == "ease_out":
                        kp.easing = "EASE_OUT"
                    else:
                        kp.easing = "EASE_IN_OUT"
                except (AttributeError, TypeError):
                    pass


def _apply_spline_path(e, o, b, scene):
    """Fly the object (usually the camera) along a smooth spline.

    `path` is a list of [x, y, z] waypoints. We build a Bezier curve with
    automatic handles (≈ Catmull-Rom smoothness), hide it from renders, and
    drive the object along it with a Follow Path constraint whose
    offset_factor is keyframed 0 → 1 over the behavior duration.

    Combine with camera.target / camera.look_at (TRACK_TO) so the camera
    keeps framing the subject while it travels — the two constraints are
    orthogonal (position vs. rotation), exactly like the orbit behavior.
    """
    waypoints = b.get("path") or b.get("waypoints") or []
    pts = []
    for wp in waypoints:
        if isinstance(wp, (list, tuple)) and len(wp) >= 3:
            try:
                pts.append((float(wp[0]), float(wp[1]), float(wp[2])))
            except (TypeError, ValueError):
                pass
    if len(pts) < 2:
        print(f"WALLERMAX_SPLINE_SKIP: need >= 2 valid waypoints, got {len(pts)}")
        return

    curve_data = bpy.data.curves.new(o.name + "_spline", type="CURVE")
    curve_data.dimensions = "3D"
    spline = curve_data.splines.new("BEZIER")
    spline.bezier_points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        bp = spline.bezier_points[i]
        bp.co = Vector(p)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    if b.get("loop"):
        spline.use_cyclic_u = True

    curve_obj = bpy.data.objects.new(o.name + "_spline", curve_data)
    bpy.context.collection.objects.link(curve_obj)
    # The helper curve must never appear in the render.
    curve_obj.hide_render = True

    c = o.constraints.new("FOLLOW_PATH")
    c.target = curve_obj
    c.use_fixed_location = True
    c.use_curve_radius = False
    # Orient along the path tangent only when no tracker will aim the object.
    cam_spec = e.get("camera", {}) or {}
    has_tracker = any(cc.type == "TRACK_TO" for cc in o.constraints) or \
        bool(cam_spec.get("target") or cam_spec.get("look_at") or b.get("target"))
    c.use_curve_follow = not has_tracker

    easing = str(b.get("easing", "ease_in_out"))
    end_frame = _clamp_end_frame(
        b.get("duration", scene.frame_end / scene.render.fps), scene)

    dp = 'constraints["%s"].offset_factor' % c.name
    c.offset_factor = 0.0
    o.keyframe_insert(data_path=dp, frame=1)
    c.offset_factor = 1.0
    o.keyframe_insert(data_path=dp, frame=end_frame)
    _set_fcurve_easing(o, "offset_factor", easing)

    print(f"WALLERMAX_SPLINE_PATH: object='{o.name}' waypoints={len(pts)} "
          f"easing={easing} end_frame={end_frame} "
          f"follow_tangent={c.use_curve_follow}")


def _apply_zoom(e, o, b, scene):
    """Animate the camera's focal length (cinematic push / pull).

    zoom_in  tightens the framing (lens grows, e.g. 35mm → 50mm)
    zoom_out widens it (lens shrinks, e.g. 50mm → 35mm).
    """
    data = getattr(o, "data", None)
    if data is None or not hasattr(data, "lens"):
        print(f"WALLERMAX_ZOOM_SKIP: '{o.name}' has no lens (not a camera)")
        return
    typ = b.get("type")
    start = float(b.get("lens_start", data.lens))
    default_end = start * (1.35 if typ == "zoom_in" else 0.75)
    end = float(b.get("lens_end", default_end))
    end_frame = _clamp_end_frame(
        b.get("duration", scene.frame_end / scene.render.fps), scene)
    easing = str(b.get("easing", "ease_in_out"))

    if data.animation_data is None:
        data.animation_data_create()
    data.lens = start
    data.keyframe_insert("lens", frame=1)
    data.lens = end
    data.keyframe_insert("lens", frame=end_frame)
    _set_fcurve_easing(data, "lens", easing)
    _verify_action_binding(data, e.get("id", o.name))
    print(f"WALLERMAX_ZOOM: '{o.name}' lens {start:.1f}mm → {end:.1f}mm "
          f"over {end_frame} frames, easing={easing}")


# ─────────────────────────────────────────────────────────────────────────
# Events
# ─────────────────────────────────────────────────────────────────────────
def apply_event(ev, objs, scene):
    target_id = ev.get("target")
    o = objs.get(target_id)
    if o is None:
        print(f"WALLERMAX_EVENT_SKIP: target '{target_id}' not found")
        return
    fps = scene.render.fps
    frame = max(1, int(float(ev.get("time", 0.0)) * fps))
    action = ev.get("action", {}) or {}
    data = getattr(o, "data", None)
    applied = []

    # IMPORTANT: In Blender 5.x, you must explicitly create animation_data
    # on an object before inserting keyframes. Otherwise keyframe_insert
    # silently fails and the object stays static.
    if o.animation_data is None:
        o.animation_data_create()
    if data is not None and getattr(data, "animation_data", None) is None:
        try:
            data.animation_data_create()
        except (AttributeError, RuntimeError):
            pass

    # IMPORTANT: for keyframes to interpolate smoothly, we need to insert
    # a keyframe at frame 1 with the object's CURRENT value (before the
    # event changes it). Otherwise Blender may hold the value constant
    # until the event frame, which looks like no movement.
    # We do this lazily: the first time we touch a property, we insert
    # a frame-1 keyframe with its current value.

    if "energy" in action and hasattr(data, "energy"):
        # Insert a baseline keyframe at frame 1 if not already keyed.
        if not _has_keyframe(data, "energy", 1):
            data.keyframe_insert("energy", frame=1)
        data.energy = float(action["energy"])
        data.keyframe_insert("energy", frame=frame)
        applied.append(f"energy={action['energy']}@frame{frame}")
    if "color" in action and hasattr(data, "color"):
        if not _has_keyframe(data, "color", 1):
            data.keyframe_insert("color", frame=1)
        data.color = norm_color(action["color"], 1.0)[:3]
        data.keyframe_insert("color", frame=frame)
        applied.append(f"color@frame{frame}")
    if "position" in action:
        # Frame 1 baseline (current position).
        if not _has_keyframe(o, "location", 1):
            ok1 = o.keyframe_insert("location", frame=1)
            print(f"WALLERMAX_KEYFRAME: {target_id}.location @ frame 1 → ok={ok1}")
        # Set new position and keyframe it at the event frame.
        o.location = v(action["position"])
        ok2 = o.keyframe_insert("location", frame=frame)
        print(f"WALLERMAX_KEYFRAME: {target_id}.location @ frame {frame} → ok={ok2} value={action['position']}")
        applied.append(f"position={action['position']}@frame{frame}")
    if "rotation" in action:
        if not _has_keyframe(o, "rotation_euler", 1):
            o.keyframe_insert("rotation_euler", frame=1)
        o.rotation_euler = [math.radians(float(x)) for x in action["rotation"]]
        o.keyframe_insert("rotation_euler", frame=frame)
        applied.append(f"rotation@frame{frame}")
    if "visible" in action:
        o.hide_viewport = not bool(action["visible"])
        o.hide_render = not bool(action["visible"])
        o.keyframe_insert("hide_viewport", frame=frame)
        o.keyframe_insert("hide_render", frame=frame)
        applied.append(f"visible={action['visible']}@frame{frame}")

    if applied:
        print(f"WALLERMAX_EVENT: target='{target_id}' → {', '.join(applied)}")
        # After inserting keyframes, verify that the action is properly
        # bound to the object's animation_data. In Blender 5.x, the action
        # created by keyframe_insert might exist in bpy.data.actions but
        # not be assigned to animation_data.action, causing the animation
        # to be invisible during render.
        #
        # IMPORTANT: we only verify the OBJECT's animation_data, not the
        # mesh/light data block. Position/rotation keyframes live on the
        # object, not on the data. Calling _verify_action_binding on the
        # data block would incorrectly assign the wrong action (the last
        # one in bpy.data.actions, which might belong to a different object).
        _verify_action_binding(o, target_id)


def _verify_action_binding(obj, label=""):
    """Verify that the object's animation_data.action is properly bound.

    In Blender 5.x, keyframe_insert() creates an Action and stores it in
    bpy.data.actions, but in some builds it doesn't automatically assign
    it to obj.animation_data.action. When that happens, the keyframes
    exist but are never evaluated during render — the object appears static.

    This function checks the binding and logs diagnostic info. If the
    action is None but there ARE actions in bpy.data.actions, we search
    for the one that was most recently created (Blender names actions
    after the object, e.g. "ball_heroAction").
    """
    ad = getattr(obj, "animation_data", None)
    if ad is None:
        print(f"WALLERMAX_ACTION_BINDING: {label} — no animation_data")
        return
    action = ad.action
    if action is None:
        # Search for an action named after this object (Blender's default
        # naming is "<object_name>Action"). We look for the action whose
        # name starts with the object's name.
        obj_name = getattr(obj, "name", label)
        expected_name = f"{obj_name}Action"
        # First try an exact match.
        candidate = bpy.data.actions.get(expected_name)
        # If no exact match, try starts-with.
        if candidate is None:
            for a in bpy.data.actions:
                if a.name.startswith(obj_name):
                    candidate = a
                    break
        # If still no match, take the last action created (best guess).
        if candidate is None and len(bpy.data.actions) > 0:
            candidate = bpy.data.actions[-1]
        if candidate is not None:
            fcurves = _get_action_fcurves(candidate)
            if fcurves:
                ad.action = candidate
                action = candidate
                print(f"WALLERMAX_ACTION_BINDING: {label} — rebound to action '{candidate.name}' ({len(fcurves)} fcurves)")
            else:
                print(f"WALLERMAX_ACTION_BINDING: {label} — candidate '{candidate.name}' has no fcurves")
        else:
            print(f"WALLERMAX_ACTION_BINDING: {label} — action is None, no actions in bpy.data.actions")
    else:
        fcurves = _get_action_fcurves(action)
        print(f"WALLERMAX_ACTION_BINDING: {label} — action='{action.name}' fcurves={len(fcurves)}")


def _get_action_fcurves(action):
    """Return the list of FCurves in an Action, across Blender 3.x/4.x/5.x.

    In Blender 3.x and 4.x, an Action exposes its FCurves directly via
    `action.fcurves`. In Blender 5.x, the "Slotted Actions" refactor moved
    FCurves into a nested structure: `action.layers[i].strips[j].
    channelbag[slot].fcurves`. The new API is the only one available in 5.2.

    This helper probes both paths and returns whichever list is available.
    Returns an empty list if neither works.
    """
    # Blender 3.x / 4.x — the classic flat structure.
    if hasattr(action, "fcurves"):
        try:
            return list(action.fcurves)
        except (RuntimeError, AttributeError):
            pass
    # Blender 5.x — the new slotted-actions structure.
    if hasattr(action, "layers"):
        fcurves = []
        try:
            for layer in action.layers:
                for strip in layer.strips:
                    # `strip.channelbag(slot)` or just `strip.channelbags[0]`.
                    if hasattr(strip, "channelbags"):
                        # Iterate all channelbags (one per slot).
                        for cb in strip.channelbags:
                            if hasattr(cb, "fcurves"):
                                fcurves.extend(cb.fcurves)
                    elif hasattr(strip, "channelbag"):
                        # Some builds expose a single channelbag.
                        cb = strip.channelbag() if callable(getattr(strip, "channelbag", None)) else strip.channelbag
                        if cb is not None and hasattr(cb, "fcurves"):
                            fcurves.extend(cb.fcurves)
        except (RuntimeError, AttributeError, TypeError):
            pass
        return fcurves
    return []


def _has_keyframe(obj, data_path, frame):
    """Check if `obj` already has a keyframe on `data_path` at `frame`."""
    if not obj.animation_data or not obj.animation_data.action:
        return False
    for fc in _get_action_fcurves(obj.animation_data.action):
        if fc.data_path == data_path:
            for kp in fc.keyframe_points:
                if int(kp.co[0]) == frame:
                    return True
    return False


# ─────────────────────────────────────────────────────────────────────────
# World environment & aesthetic
# ─────────────────────────────────────────────────────────────────────────
def setup_world(world_block):
    bpy.context.scene.world = bpy.data.worlds.new("WallermaxWorld")
    w = bpy.context.scene.world
    env = world_block.get("environment", {}) or {}
    aesthetic = world_block.get("aesthetic", {}) or {}

    # In Blender 5.x, use_nodes still works but emits a DeprecationWarning.
    # We use a defensive helper that prefers the new API when available.
    tree = _get_world_node_tree(w)
    if tree is None:
        # No node tree available — fall back to the simple color property.
        ambient = env.get("ambient_color", [0.04, 0.04, 0.04])
        # World.color is the legacy "no-nodes" color, still supported everywhere.
        w.color = norm_color(ambient, 0.04)[:3]
        return

    # Get (or create) the Background and World Output nodes.
    bg = tree.nodes.get("Background")
    if bg is None:
        bg = tree.nodes.new("ShaderNodeBackground")
    out = None
    for n in tree.nodes:
        if n.type == "OUTPUT_WORLD":
            out = n
            break
    if out is None:
        out = tree.nodes.new("ShaderNodeOutputWorld")

    strength = float(env.get("ambient_intensity", 1.0))

    # ── Environment strategy (best available wins) ───────────────────
    #   1. HDRI environment texture (world.environment.hdri.path resolves
    #      to a real file — uploads included)
    #   2. Nishita physical sky (world.environment.sky)
    #   3. Flat ambient color (historical behavior, incl. palette tint)
    # Realism note: in archviz and product work the environment lighting
    # contributes most of the image — a flat color can never match it.
    applied = _apply_hdri_env(tree, env.get("hdri"), bg)
    if not applied:
        applied = _apply_sky_env(tree, env.get("sky"), bg)
    if not applied:
        ambient = env.get("ambient_color", [0.04, 0.04, 0.04])
        bg.inputs["Color"].default_value = norm_color(ambient, 0.04)
        # Drive the ambient color from the palette if available.
        palette = aesthetic.get("palette", [])
        if palette and len(palette) >= 1 and len(palette[0]) >= 3:
            bg.inputs["Color"].default_value = norm_color(palette[0], 0.04)

    bg.inputs["Strength"].default_value = strength
    try:
        tree.links.new(bg.outputs["Background"], out.inputs["Surface"])
    except (RuntimeError, AttributeError) as exc:
        print(f"WALLERMAX_WORLD_LINK_FAIL: {exc}")


def _apply_hdri_env(tree, hdri, bg):
    """Attach an HDRI environment texture. Returns True on success.

    The file is resolved exactly like PBR textures (absolute path, upload
    dir, recursive walk), so an uploaded .hdr just works. HDR/exr images
    are scene-linear radiance data and are marked Non-Color so Blender
    does not apply an sRGB decode.
    """
    if not isinstance(hdri, dict) or not hdri.get("path"):
        return False
    path = hdri.get("path")
    resolved = resolve_texture_path(str(path), _CURRENT_UPLOAD_DIR)
    if not resolved or not Path(str(resolved)).exists():
        print(f"WALLERMAX_HDRI_SKIP: '{path}' not found (resolved: {resolved})")
        return False
    try:
        env_tex = tree.nodes.new("ShaderNodeTexEnvironment")
        img = bpy.data.images.load(str(resolved), check_existing=True)
        try:
            img.colorspace_settings.name = "Non-Color"
        except (RuntimeError, TypeError):
            pass
        env_tex.image = img
        rot = float(hdri.get("rotation_z", 0.0))
        if abs(rot) > 0.001:
            mapping = tree.nodes.new("ShaderNodeMapping")
            tex_coord = tree.nodes.new("ShaderNodeTexCoord")
            mapping.inputs["Rotation"].default_value[2] = math.radians(rot)
            tree.links.new(tex_coord.outputs["Generated"], mapping.inputs["Vector"])
            tree.links.new(mapping.outputs["Vector"], env_tex.inputs["Vector"])
        tree.links.new(env_tex.outputs["Color"], bg.inputs["Color"])
        print(f"WALLERMAX_HDRI: '{Path(str(resolved)).name}' rotation_z={rot}°")
        return True
    except (RuntimeError, TypeError, AttributeError) as exc:
        print(f"WALLERMAX_HDRI_FAIL: {exc}")
        return False


def _apply_sky_env(tree, sky, bg):
    """Attach a Nishita physical sky (with matching sun). Returns True.

    The Nishita model is a physically-based atmospheric simulation: give it
    a sun elevation/rotation and you get believable sky gradients, sun disc
    and (in Cycles) real sunlight with correct color for free.
    """
    if not isinstance(sky, dict):
        return False
    try:
        sky_tex = tree.nodes.new("ShaderNodeTexSky")
    except (RuntimeError, TypeError) as exc:
        print(f"WALLERMAX_SKY_SKIP: {exc}")
        return False
    try:
        sky_tex.sky_type = "NISHITA"
    except (TypeError, RuntimeError):
        pass
    elevation_deg = float(sky.get("sun_elevation", 45.0))
    rotation_deg = float(sky.get("sun_rotation", 135.0))
    elev = math.radians(elevation_deg)
    rot = math.radians(rotation_deg)
    try:
        sky_tex.sun_elevation = elev
        sky_tex.sun_rotation = rot
    except (TypeError, RuntimeError, AttributeError):
        pass
    for attr, key in (("altitude", "altitude"), ("air_density", "air_density"),
                      ("dust_density", "dust_density"), ("ozone", "ozone")):
        if key in sky and hasattr(sky_tex, attr):
            try:
                setattr(sky_tex, attr, float(sky[key]))
            except (TypeError, RuntimeError):
                pass
    tree.links.new(sky_tex.outputs["Color"], bg.inputs["Color"])
    _add_sun_from_sky(elev, rot, sky)
    print(f"WALLERMAX_SKY: nishita sun_elevation={elevation_deg}° "
          f"sun_rotation={rotation_deg}° altitude={sky.get('altitude', 1000)}m")
    return True


def _add_sun_from_sky(elev, rot, sky):
    """Create a SUN light matching the Nishita sky's sun direction.

    Cycles already receives sunlight from the sky texture itself, so the
    extra light is only added there when explicitly requested via
    sky.sun_light = true. EEVEE cannot get irradiance from the sky texture,
    so a matching SUN light is added by default (with a warm 5500K tint).
    """
    engine = bpy.context.scene.render.engine
    default_want = engine != "CYCLES"
    want = sky.get("sun_light", default_want)
    if not want:
        return None
    # Direction from the scene origin toward the sun's position in the sky.
    d = Vector((math.cos(elev) * math.cos(rot),
                math.cos(elev) * math.sin(rot),
                math.sin(elev)))
    data = bpy.data.lights.new("wallermax_sky_sun", "SUN")
    data.energy = float(sky.get("sun_strength", 3.0))
    try:
        data.color = tuple(kelvin_to_rgb(float(sky.get("color_temperature_k", 5500))))
    except (TypeError, ValueError, RuntimeError):
        pass
    obj = bpy.data.objects.new("wallermax_sky_sun", data)
    bpy.context.collection.objects.link(obj)
    # A SUN light shines along its local -Z axis; aim it at the origin.
    obj.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    obj.location = d * 20.0
    obj["provenance"] = "inferred"
    obj["confidence"] = 1.0
    print(f"WALLERMAX_SKY_SUN: energy={data.energy} (engine={engine})")
    return obj


def _get_world_node_tree(world):
    """Return the World's shader node tree, or None if unavailable.

    In Blender 5.x, `world.use_nodes = True` is deprecated. The tree is
    accessed via `world.node_tree` after enabling nodes, but enabling
    nodes itself can fail on some builds. We try multiple paths.
    """
    try:
        world.use_nodes = True
    except (AttributeError, TypeError, KeyError):
        pass
    try:
        if hasattr(world, "node_tree") and world.node_tree is not None:
            return world.node_tree
    except (AttributeError, TypeError):
        pass
    return None


def setup_render(world_block):
    s = bpy.context.scene
    r = world_block.get("render", {}) or {}

    # ── Choose the render engine ──────────────────────────────────────
    # The engine name changed across Blender versions:
    #   - Blender 3.x, 4.0, 4.1 : "BLENDER_EEVEE"
    #   - Blender 4.2+           : "BLENDER_EEVEE_NEXT"
    #   - Cycles                 : "CYCLES" (same across versions)
    # v1.2.0 BUG FIX: the old code only set the chosen_engine VARIABLE for
    # CYCLES but never assigned scene.render.engine — so a World Model that
    # requested Cycles silently rendered with the scene's default engine
    # (EEVEE). Now every candidate is actually assigned (with fallbacks).
    requested_engine = r.get("engine", "BLENDER_EEVEE_NEXT")
    engine_candidates = [requested_engine]
    for alt in ("CYCLES", "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        if alt not in engine_candidates:
            engine_candidates.append(alt)
    chosen_engine = requested_engine
    for candidate in engine_candidates:
        try:
            s.render.engine = candidate
            chosen_engine = candidate
            break
        except (TypeError, AttributeError):
            continue
    print(f"WALLERMAX_ENGINE_CHOSEN: {chosen_engine} (requested: {requested_engine})")

    s.render.fps = int(r.get("fps", 30))
    s.render.resolution_x = int(r.get("width", 1280))
    s.render.resolution_y = int(r.get("height", 720))
    # Render at 100% resolution. Lowering this is a cheap way to speed up
    # the render, but it produces visibly soft output. We keep 100% and
    # let the user choose the resolution via the World Model.
    s.render.resolution_percentage = 100
    duration = float(r.get("duration", 10))
    s.frame_start = 1
    s.frame_end = max(1, int(duration * s.render.fps))

    # ── Quality preset (v1.2.0) ────────────────────────────────────
    # preview   → the historical fast-but-rough tuning (iteration only)
    # standard  → soft shadows + SSR, 64 TAA samples (new default)
    # cinematic → motion blur (180° shutter), soft shadows, SSR/raytracing,
    #             GTAO, 128 TAA samples (EEVEE) or 128+ samples with
    #             OpenImageDenoise (Cycles), larger shadow maps
    quality = str(r.get("quality", "standard")).strip().lower()
    if quality not in {"preview", "standard", "cinematic"}:
        quality = "standard"
    _apply_quality_settings(s, chosen_engine, quality, r)

    env = world_block.get("environment", {}) or {}
    s.gravity = Vector(env.get("gravity", [0, 0, -9.81]))

    # Sub-frame physics for stability. In Blender 4.x and 5.x, the
    # rigidbody_world attribute on a fresh scene is None until a rigidbody
    # object is added. We create it lazily here so that scenes with physics
    # entities get the right substeps. If creation fails (some Blender
    # builds don't expose bpy.ops.rigidbody.world_add in background mode),
    # we silently skip — physics will still work, just with default substeps.
    if s.rigidbody_world is None:
        try:
            bpy.ops.rigidbody.world_add()
        except (RuntimeError, AttributeError):
            pass
    if s.rigidbody_world is not None:
        try:
            s.rigidbody_world.substeps_per_frame = max(1, int(env.get("substeps_per_frame", 2)))
            s.rigidbody_world.points_per_frame = max(1, int(env.get("points_per_frame", 8)))
        except (AttributeError, TypeError):
            pass


def _apply_quality_settings(s, chosen_engine, quality, r):
    """Apply engine settings for the requested quality preset.

    preview   — the historical fast tuning (16 TAA samples, cheap shadows,
                no motion blur). For quick iteration only.
    standard  — a balanced look: 64 TAA samples, soft shadows, screen-space
                reflections. No motion blur (it doubles render time).
    cinematic — maximum fidelity: 128 TAA samples (EEVEE) or 128+ path-traced
                samples with OpenImageDenoise (Cycles), soft shadows, SSR /
                raytracing, ambient occlusion, volumetric shadows, filmic
                motion blur (shutter centered, 180° by default), larger
                shadow maps.

    Every attribute is guarded with hasattr() because their availability
    varies wildly across Blender 3.x / 4.x / 5.x (e.g. legacy EEVEE's
    use_ssr was removed in EEVEE Next, where use_raytracing replaces it).
    """
    shutter = float(r.get("shutter", 0.5))

    if chosen_engine == "CYCLES":
        requested_samples = int(r.get("samples", 32))
        if quality == "cinematic":
            # Smart floor: cinematic Cycles needs enough samples for a clean
            # image. If the request carried a low count (the web UI defaults
            # to 16), raise it to a cinematic floor instead of rendering noise.
            samples = max(requested_samples, 128)
        elif quality == "standard":
            samples = max(requested_samples, 48)
        else:
            samples = requested_samples
        s.cycles.samples = samples
        s.cycles.use_denoising = True
        # Prefer the high-quality OpenImageDenoiser when this build has it.
        try:
            if hasattr(s.cycles, "denoiser"):
                s.cycles.denoiser = "OPENIMAGEDENOISE"
        except (TypeError, RuntimeError):
            pass
        # Adaptive sampling concentrates samples where they matter.
        try:
            if hasattr(s.cycles, "use_adaptive_sampling"):
                s.cycles.use_adaptive_sampling = True
        except (TypeError, RuntimeError):
            pass
        # Cinematic motion blur: shutter centered on the frame (film-like).
        try:
            if hasattr(s.cycles, "motion_blur_position"):
                s.cycles.motion_blur_position = "CENTER"
        except (TypeError, RuntimeError):
            pass
        # Use the GPU if available (much faster than CPU).
        try:
            prefs = bpy.context.preferences.addons["cycles"].preferences
            prefs.compute_device_type = "CUDA"
            for device in prefs.devices:
                device.use = True
            s.cycles.device = "GPU"
        except (KeyError, AttributeError, RuntimeError):
            pass
        print(f"WALLERMAX_CYCLES_TUNED: quality={quality} samples={samples} "
              f"denoising=on (OIDN preferred) adaptive=on motion_blur=center")

    if chosen_engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            eevee = s.eevee
            # Bloom is handled in the compositor (Glare node) since EEVEE
            # Next removed the legacy bloom panel.
            if hasattr(eevee, "use_bloom"):
                eevee.use_bloom = False

            # ── Per-quality attribute table ──
            table = {
                "taa_render_samples":    {"preview": 16, "standard": 64, "cinematic": 128},
                "taa_samples":           {"preview": 8,  "standard": 16, "cinematic": 32},
                "use_soft_shadows":      {"preview": False, "standard": True, "cinematic": True},
                "use_ssr":               {"preview": False, "standard": True, "cinematic": True},
                "use_ssr_refraction":    {"preview": False, "standard": False, "cinematic": True},
                "use_volumetric_shadows": {"preview": False, "standard": False, "cinematic": True},
                "use_gtao":              {"preview": False, "standard": False, "cinematic": True},
                "use_motion_blur":       {"preview": False, "standard": False, "cinematic": True},
                "use_raytracing":        {"preview": False, "standard": False, "cinematic": True},
                "use_fast_gtao":         {"preview": False, "standard": False, "cinematic": True},
            }
            for attr, values in table.items():
                if hasattr(eevee, attr):
                    try:
                        setattr(eevee, attr, values[quality])
                    except (TypeError, RuntimeError):
                        pass
            # Legacy EEVEE only: half-res SSR is a quality killer.
            if hasattr(eevee, "use_ssr_halfres"):
                try:
                    eevee.use_ssr_halfres = False
                except (TypeError, RuntimeError):
                    pass
            # Motion-blur shutter length (film cameras: ~0.5 = 180°).
            if hasattr(eevee, "motion_blur_shutter") and quality == "cinematic":
                try:
                    eevee.motion_blur_shutter = shutter
                except (TypeError, RuntimeError):
                    pass
            # Larger shadow maps for cinematic (crisper contact shadows).
            if quality == "cinematic":
                for attr in ("shadow_cube_size", "shadow_cascade_size"):
                    if hasattr(eevee, attr):
                        try:
                            setattr(eevee, attr, "2048")
                        except (TypeError, RuntimeError):
                            pass
            print(f"WALLERMAX_EEVEE_TUNED: quality={quality} "
                  f"samples={table['taa_render_samples'][quality]} "
                  f"soft_shadows={table['use_soft_shadows'][quality]} "
                  f"ssr={table['use_ssr'][quality]} "
                  f"motion_blur={table['use_motion_blur'][quality]} shutter={shutter}")
        except (AttributeError, TypeError, RuntimeError) as exc:
            print(f"WALLERMAX_EEVEE_TUNING_SKIP: {exc}")


def setup_color_management(scene, aesthetic):
    """Configure cinematic color management.

    Blender 4.x/5.x ship AgX, a tone mapper designed for film-like color;
    older builds have Filmic. We pick the best available, apply a
    medium-high-contrast look, and — when the aesthetic block requests an
    exposure shift — apply it here (pre-tonemapping, which is
    colorimetrically correct) instead of the compositor's post-tone
    exposure node.

    Returns True when the exposure was applied at the view-transform stage
    so the compositor can skip its own exposure node (avoiding a
    double-application).
    """
    vs = getattr(scene, "view_settings", None)
    if vs is None:
        print("WALLERMAX_COLOR_MGMT_SKIP: no view_settings on this build")
        return False
    chosen = None
    for cand in ("AgX", "Filmic", "Standard"):
        try:
            vs.view_transform = cand
            chosen = cand
            break
        except (TypeError, RuntimeError):
            continue
    look = None
    for cand in ("AgX - Medium High Contrast", "Filmic - Medium High Contrast",
                 "Medium High Contrast", "None"):
        try:
            vs.look = cand
            look = cand
            break
        except (TypeError, RuntimeError):
            continue
    applied_exposure = False
    ev = aesthetic.get("exposure_ev") if isinstance(aesthetic, dict) else None
    if isinstance(ev, (int, float)) and float(ev) != 0.0:
        try:
            vs.exposure = float(ev)
            applied_exposure = True
        except (TypeError, RuntimeError):
            pass
    print(f"WALLERMAX_COLOR_MGMT: view_transform={chosen} look={look} "
          f"exposure_ev={'applied' if applied_exposure else 'skipped'}")
    return applied_exposure


# ─────────────────────────────────────────────────────────────────────────
# Aesthetic post (compositor)
# ─────────────────────────────────────────────────────────────────────────
def _get_compositor_tree():
    """Return the scene's compositor node tree, or None if unavailable.

    The compositor API changed across Blender versions:
      - 3.x / 4.x: `scene.use_nodes = True; tree = scene.node_tree`
      - 5.2+:      `scene.node_tree` was REMOVED. The compositor is a node
                   group: `scene.compositing_node_group` (create one with
                   bpy.data.node_groups.new(name, "CompositorNodeTree") if
                   None) and the output node is a plain NodeGroupOutput.
    This helper tries every path so the script keeps working across
    Blender versions. Returns None if none of them work (the caller can
    then skip the compositor pass without crashing the render).
    """
    s = bpy.context.scene
    # 1. Classic API (Blender 3.x / 4.x).
    try:
        s.use_nodes = True
        if s.node_tree is not None:
            return s.node_tree
    except (AttributeError, TypeError):
        pass
    # 2. New API (Blender 5.2+): compositing node group.
    if hasattr(s, "compositing_node_group"):
        try:
            s.use_nodes = True  # deprecated in 5.x but still enables compositing
        except (AttributeError, TypeError):
            pass
        ng = getattr(s, "compositing_node_group", None)
        if ng is None:
            try:
                ng = bpy.data.node_groups.new("WallermaxCompositor",
                                              "CompositorNodeTree")
                s.compositing_node_group = ng
            except (RuntimeError, TypeError) as exc:
                print(f"WALLERMAX_COMPOSITOR_SKIP: cannot create CompositorNodeTree ({exc})")
                return None
        return ng
    # 3. Last resort: the first view layer's node tree (very old builds).
    try:
        if len(s.view_layers) > 0:
            vl = s.view_layers[0]
            if hasattr(vl, "node_tree") and vl.node_tree is not None:
                return vl.node_tree
    except (AttributeError, TypeError):
        pass
    return None


# ── Compositor helpers (version-tolerant: Blender 3.x / 4.x / 5.x) ──────
def _try_new_node(nodes, node_type):
    """Create a compositor node, or None if the type doesn't exist in this
    Blender build (several classic nodes were removed/renamed in 5.2)."""
    try:
        return nodes.new(node_type)
    except (RuntimeError, TypeError):
        return None


def _set_socket(node, names, value):
    """Set the first existing input among `names` to value (scalar or tuple).

    Handles renames across versions (e.g. EllipseMask's 'Mask Width/Height'
    became the 'Size' 2D vector in 5.2; Blur's size properties became a
    'Size' pixel-vector input). Returns True on success.
    """
    for name in names:
        try:
            sock = node.inputs[name]
        except (KeyError, RuntimeError):
            continue
        try:
            sock.default_value = value
            return True
        except (TypeError, RuntimeError):
            continue
    return False


def _set_color_socket(node, name, value):
    """Set the COLOR socket called `name` (some 5.2 nodes expose both a
    float-factor and a color socket with the same name — e.g. ColorBalance's
    Gain). Returns True on success."""
    for sock in node.inputs:
        if sock.name == name and sock.bl_idname == "NodeSocketColor":
            try:
                sock.default_value = value
                return True
            except (TypeError, RuntimeError):
                return False
    return False


def _new_compositor_output(nodes):
    """Create the compositor output node for this Blender version.

    ≤4.x: CompositorNodeComposite (input 'Image').
    5.x:  the compositor is a node group — use NodeGroupOutput (input 0).
    Returns (node, input_socket).
    """
    comp = _try_new_node(nodes, "CompositorNodeComposite")
    if comp is not None:
        try:
            return comp, comp.inputs["Image"]
        except (KeyError, RuntimeError):
            pass
    out = _try_new_node(nodes, "NodeGroupOutput")
    if out is not None and len(out.inputs) > 0:
        return out, out.inputs[0]
    return None, None


def setup_compositor(aesthetic, quality="standard", exposure_applied=False):
    """Apply the compositor finishing pass.

    Chain (each stage optional, driven by the aesthetic block):
      Render Layers → [exposure] → [color-temperature grade]
        → [bloom (Glare)] → [chromatic aberration] → [vignette]
        → [film grain] → Output

    v1.2.0 fixes & additions:
      - The vignette actually multiplies the image now (the old code created
        mask nodes but never linked them into the chain — dead code). The
        new chain (EllipseMask → Blur → SetAlpha → AlphaOver over black)
        is a true multiply and works on every Blender version.
      - Film grain: a seeded, deterministic noise image translated by a
        per-frame pseudo-random offset so the grain "lives" (animated).
      - Chromatic aberration via lens dispersion (≤4.x; node removed in 5.2).
      - Bloom via the Glare node — works in every engine and version.
      - Color-temperature grade (warm/cool) from aesthetic.color_temperature_k.
      - Exposure is applied pre-tonemap via scene.view_settings when
        available; the compositor node is only a fallback.
      - Version-tolerant node creation: every stage degrades gracefully,
        reporting what it could not apply so the caller can fall back to
        the ffmpeg finishing pass (vignette/grain via ffmpeg filters).

    Returns a dict describing what was applied and what is still pending
    (keys 'pending_vignette' / 'pending_grain' carry the requested strength
    for the ffmpeg pass).
    """
    finish = {"vignette": False, "grain": False, "ca": False,
              "pending_vignette": None, "pending_grain": None}
    if not aesthetic and quality != "cinematic":
        return finish
    s = bpy.context.scene
    tree = _get_compositor_tree()
    if tree is None:
        print("WALLERMAX_COMPOSITOR_SKIP: no compositor node tree available in this Blender build")
        if aesthetic.get("vignette"):
            finish["pending_vignette"] = max(0.05, min(1.0, float(aesthetic["vignette"])))
        if aesthetic.get("grain"):
            finish["pending_grain"] = max(0.0, min(1.0, float(aesthetic["grain"])))
        # Even though we can't composite, we can still try to apply bloom
        # via the EEVEE settings (if available).
        _apply_eevee_bloom(s, aesthetic)
        return finish
    try:
        s.render.use_compositing = True
    except (AttributeError, TypeError):
        pass
    nodes = tree.nodes
    links = tree.links
    nodes.clear()

    rl = nodes.new("CompositorNodeRLayers")
    comp, comp_in = _new_compositor_output(nodes)
    if comp is None:
        print("WALLERMAX_COMPOSITOR_SKIP: no output node available")
        return finish
    last = rl.outputs["Image"]
    applied = []

    # 1. Exposure (only if the view-transform stage didn't already do it).
    exposure = aesthetic.get("exposure_ev")
    if exposure and not exposure_applied:
        exp = _try_new_node(nodes, "CompositorNodeExposure")
        if exp is not None:
            try:
                exp.inputs["Exposure"].default_value = float(exposure)
                links.new(last, exp.inputs["Image"])
                last = exp.outputs["Image"]
                applied.append("exposure")
            except (RuntimeError, TypeError) as exc:
                print(f"WALLERMAX_EXPOSURE_SKIP: {exc}")

    # 2. Color-temperature grade (warm < 6500K < cool), very subtle.
    kelvin = aesthetic.get("color_temperature_k")
    if kelvin:
        cb = _try_new_node(nodes, "CompositorNodeColorBalance")
        if cb is not None:
            d = max(-0.5, min(0.5, (float(kelvin) - 6500.0) / 6500.0))
            a = -d * 0.12  # warm: R up / B down — cool: R down / B up
            if _set_color_socket(cb, "Gain", (1.0 + a, 1.0, 1.0 - a, 1.0)):
                try:
                    links.new(last, cb.inputs["Image"])
                    last = cb.outputs["Image"]
                    applied.append(f"temp={kelvin}K")
                except (RuntimeError, TypeError) as exc:
                    print(f"WALLERMAX_TEMP_SKIP: {exc}")
            else:
                print("WALLERMAX_TEMP_SKIP: no Gain color socket")

    # 3. Bloom via the Glare node (engine- and version-independent).
    bloom = aesthetic.get("bloom")
    if bloom:
        glare = _try_new_node(nodes, "CompositorNodeGlare")
        if glare is not None:
            b = max(0.0, min(1.0, float(bloom)))
            type_set = False
            try:
                glare.glare_type = "BLOOM"  # ≤4.x property
                type_set = True
            except (AttributeError, TypeError):
                type_set = _set_socket(glare, ("Type",), "Bloom")  # 5.x menu input
            if type_set:
                try:
                    glare.size = max(1, int(round(4 + b * 4)))  # ≤4.x property
                except (AttributeError, TypeError):
                    _set_socket(glare, ("Size",), min(0.9, 0.3 + b * 0.3))
                try:
                    links.new(last, glare.inputs["Image"])
                    last = glare.outputs["Image"]
                    applied.append(f"bloom={bloom}")
                except (RuntimeError, TypeError) as exc:
                    print(f"WALLERMAX_GLARE_SKIP: {exc}")
        else:
            print("WALLERMAX_GLARE_SKIP: Glare node unavailable")

    # 4. Chromatic aberration (lens dispersion). Subtle default in cinematic.
    #    (CompositorNodeLensDistortion was removed in Blender 5.2 — skipped.)
    ca = aesthetic.get("chromatic_aberration")
    if ca is None and quality == "cinematic":
        ca = 0.02
    if ca:
        lens = _try_new_node(nodes, "CompositorNodeLensDistortion")
        if lens is None:
            print("WALLERMAX_CA_SKIP: LensDistortion node unavailable in this Blender build")
        else:
            try:
                lens.inputs["Dispersion"].default_value = max(0.0, min(1.0, float(ca)))
                links.new(last, lens.inputs["Image"])
                last = lens.outputs["Image"]
                applied.append(f"ca={ca}")
                finish["ca"] = True
            except (RuntimeError, TypeError) as exc:
                print(f"WALLERMAX_CA_SKIP: {exc}")

    # 5. Vignette — soft elliptical mask multiplied over the image.
    #    True multiply chain that works on every version:
    #    EllipseMask → Gaussian Blur → SetAlpha(image, alpha=mask)
    #    → AlphaOver(fg=image·mask, bg=black, factor=1)
    #    Center (mask=1) → image untouched; corners (mask=0) → black.
    vignette = aesthetic.get("vignette")
    if vignette:
        v = max(0.05, min(1.0, float(vignette)))
        try:
            mask = _try_new_node(nodes, "CompositorNodeEllipseMask")
            blur = _try_new_node(nodes, "CompositorNodeBlur")
            setalpha = _try_new_node(nodes, "CompositorNodeSetAlpha")
            alphaover = _try_new_node(nodes, "CompositorNodeAlphaOver")
            if None in (mask, blur, setalpha, alphaover):
                raise RuntimeError("vignette nodes unavailable in this build")
            # Ellipse size shrinks with strength; blur softens the falloff.
            size = min(1.0, 1.10 - 0.35 * v)
            if not _set_socket(mask, ("Size",), (size, size)):  # 5.2: 2D vector
                _set_socket(mask, ("Mask Width",), size)        # ≤4.x: floats
                _set_socket(mask, ("Mask Height",), size)
            blur_px = max(10.0, (15.0 + 55.0 * v) * float(s.render.resolution_y) / 1080.0)
            if not _set_socket(blur, ("Size",), (blur_px, blur_px)):  # 5.2: pixel vector
                for attr in ("size_x", "size_y"):                   # ≤4.x: properties
                    if hasattr(blur, attr):
                        try:
                            setattr(blur, attr, blur_px)
                        except (TypeError, RuntimeError):
                            pass
            try:
                blur.filter_type = "GAUSSIAN"  # ≤4.x property
            except (AttributeError, TypeError):
                _set_socket(blur, ("Type",), "Gaussian")  # 5.x menu input
            links.new(mask.outputs["Mask"], blur.inputs["Image"])
            links.new(last, setalpha.inputs["Image"])
            links.new(blur.outputs["Image"], setalpha.inputs["Alpha"])
            links.new(setalpha.outputs["Image"], alphaover.inputs["Foreground"])
            _set_color_socket(alphaover, "Background", (0.0, 0.0, 0.0, 1.0))
            _set_socket(alphaover, ("Factor",), 1.0)
            last = alphaover.outputs["Image"]
            finish["vignette"] = True
            applied.append(f"vignette={vignette}")
        except (RuntimeError, TypeError) as exc:
            print(f"WALLERMAX_VIGNETTE_SKIP: {exc}")
            finish["pending_vignette"] = v

    # 6. Film grain — seeded noise, per-frame offset (deterministic).
    #    Needs a color Mix node (≤4.x only; removed in 5.2 → ffmpeg pass).
    grain = aesthetic.get("grain")
    if grain:
        g = max(0.0, min(1.0, float(grain)))
        try:
            mix, mix_out = _new_color_mix_node(nodes, "OVERLAY",
                                               max(0.0, min(0.5, g * 0.35)))
            if mix is None:
                raise RuntimeError("no color Mix node in this build")
            last = _apply_film_grain(tree, s, last, g, mix, mix_out)
            finish["grain"] = True
            applied.append(f"grain={grain}")
        except (RuntimeError, TypeError) as exc:
            print(f"WALLERMAX_GRAIN_SKIP: {exc} — will fall back to the ffmpeg noise filter")
            finish["pending_grain"] = g

    links.new(last, comp_in)
    print(f"WALLERMAX_COMPOSITOR: quality={quality} stages=[{', '.join(applied) or 'none'}]")
    return finish


def _new_color_mix_node(nodes, blend_type, fac):
    """Create a color Mix node across Blender versions.

    Blender <= 4.x uses CompositorNodeMixRGB; 5.x removed it entirely (and
    CompositorNodeMix doesn't exist there either). Returns (None, None)
    when no mix node is available so callers can degrade gracefully.
    """
    try:
        mix = nodes.new("CompositorNodeMixRGB")
        mix.blend_type = blend_type
        mix.inputs["Fac"].default_value = fac
        return mix, mix.outputs["Image"]
    except (RuntimeError, TypeError, KeyError):
        pass
    try:
        mix = nodes.new("CompositorNodeMix")
        try:
            mix.data_type = "COLOR"
            mix.blend_type = blend_type
        except (RuntimeError, TypeError):
            pass
        try:
            mix.inputs["Fac"].default_value = fac
        except (RuntimeError, TypeError):
            pass
        out = None
        for socket in mix.outputs:
            if socket.name in ("Image", "Result Color", "ResultColor"):
                out = socket
                break
        return mix, out if out is not None else mix.outputs[0]
    except (RuntimeError, TypeError):
        return None, None


def _apply_film_grain(tree, scene, image_socket, grain_strength, mix, mix_out):
    """Overlay animated film grain. Fully deterministic (fixed seeds).

    A noise image (frame size + 256px margin) is generated with a seeded
    PRNG, then translated by a per-frame pseudo-random offset inside that
    margin so the pattern jitters like real film grain. Offsets are
    keyframed with CONSTANT interpolation = a new offset every frame.
    The mix node must be pre-created by the caller (version-dependent).
    """
    nodes = tree.nodes
    links = tree.links
    w = int(scene.render.resolution_x) + 256
    h = int(scene.render.resolution_y) + 256
    rnd = random.Random(20240917)
    vals = [0.5 + (rnd.random() - 0.5) * 0.55 for _ in range(w * h)]
    flat = []
    append = flat.append
    for v in vals:
        append(v)
        append(v)
        append(v)
        append(1.0)
    img = bpy.data.images.new("wallermax_grain", width=w, height=h, alpha=False)
    try:
        img.colorspace_settings.name = "Non-Color"
    except (RuntimeError, TypeError):
        pass
    img.pixels[:] = flat
    del vals, flat

    img_node = nodes.new("CompositorNodeImage")
    img_node.image = img
    tr = nodes.new("CompositorNodeTranslate")
    links.new(img_node.outputs["Image"], tr.inputs["Image"])
    rnd2 = random.Random(9182)
    frame_start = int(scene.frame_start)
    frame_end = int(scene.frame_end)
    dp_x = 'nodes["%s"].inputs[1].default_value' % tr.name
    dp_y = 'nodes["%s"].inputs[2].default_value' % tr.name
    for f in range(frame_start, frame_end + 1):
        dx = 16.0 + rnd2.random() * 224.0
        dy = 16.0 + rnd2.random() * 224.0
        tr.inputs["X"].default_value = dx
        tr.keyframe_insert(data_path=dp_x, frame=f)
        tr.inputs["Y"].default_value = dy
        tr.keyframe_insert(data_path=dp_y, frame=f)
    # CONSTANT interpolation → the offset jumps every frame (real grain).
    ad = tree.animation_data
    if ad and ad.action:
        for fc in _get_action_fcurves(ad.action):
            if "default_value" in (fc.data_path or ""):
                for kp in fc.keyframe_points:
                    kp.interpolation = "CONSTANT"
    links.new(image_socket, mix.inputs[1])
    links.new(tr.outputs["Image"], mix.inputs[2])
    print(f"WALLERMAX_GRAIN: {w}x{h} noise, per-frame offsets, "
          f"fac={grain_strength * 0.35:.3f}")
    return mix_out


def _apply_eevee_bloom(scene, aesthetic):
    """Apply bloom via the EEVEE settings (works on EEVEE 3.x/4.0/4.1)."""
    bloom = aesthetic.get("bloom")
    if not bloom:
        return
    if not hasattr(scene, "eevee"):
        return
    try:
        if hasattr(scene.eevee, "use_bloom"):
            scene.eevee.use_bloom = True
        if hasattr(scene.eevee, "bloom_intensity"):
            scene.eevee.bloom_intensity = float(bloom)
    except (TypeError, AttributeError):
        pass


# ─────────────────────────────────────────────────────────────────────────
# Custom properties (provenance / confidence)
# ─────────────────────────────────────────────────────────────────────────
def stamp_metadata(o, e):
    o["provenance"] = e.get("provenance", "inferred")
    o["confidence"] = float(e.get("confidence", 0.5))
    if e.get("locked"):
        o["locked"] = True
    if e.get("name"):
        o["label"] = e["name"]


# ─────────────────────────────────────────────────────────────────────────
# Main compiler
# ─────────────────────────────────────────────────────────────────────────
def compile_world(world, out_dir):
    global _CURRENT_UPLOAD_DIR
    _CURRENT_UPLOAD_DIR = str(Path(out_dir) / "_uploads") if Path(out_dir).exists() else str(out_dir)
    scene = bpy.context.scene
    setup_render(world.get("world", {}))
    setup_world(world.get("world", {}))

    # ── Color management (AgX/Filmic + pre-tonemap exposure) ────────
    aesthetic = (world.get("world", {}) or {}).get("aesthetic", {}) or {}
    render_cfg = (world.get("world", {}) or {}).get("render", {}) or {}
    quality = str(render_cfg.get("quality", "standard")).strip().lower()
    if quality not in {"preview", "standard", "cinematic"}:
        quality = "standard"
    exposure_applied = setup_color_management(scene, aesthetic)

    objs = {}

    # ── First pass: create objects (no parenting yet) ──────────────
    for e in world["entities"]:
        typ = e["type"]
        g = e.get("geometry", {}) or {}
        mat = make_material(e["id"] + "_mat", e.get("material")) if e.get("material") else None
        pos = (e.get("transform", {}) or {}).get("position", [0, 0, 0])

        if typ == "room":
            build_room(e)
            # A8: Register the room in objs so behaviors can target it
            # by id. We create an empty at the room's center (its transform
            # position, defaulting to [0,0,0]) as a stable anchor for
            # orbit/look_at/follow behaviors.
            try:
                room_pos = (e.get("transform", {}) or {}).get("position", [0, 0, 0])
                room_anchor = add_empty(e["id"] + "_anchor", room_pos)
                if room_anchor is not None:
                    objs[e["id"]] = room_anchor
            except Exception as exc:
                print(f"WALLERMAX_ROOM_ANCHOR_FAIL: '{e.get('id')}' - {exc}")
            continue
        if typ in {"light", "point_light", "area_light", "spot_light", "sun"}:
            o = add_light(e)
        elif typ == "camera":
            o = add_camera(e, objs)
        elif typ in {"model", "asset", "mesh"} or g.get("file"):
            o = import_model(e, g, pos, mat)
            if o is None:
                # Import failed — keep the scene visible with a placeholder.
                o = add_box(e["id"], [0.5, 0.5, 0.5], pos, mat)
        elif typ in {"sphere", "ball"} or g.get("shape") == "sphere":
            o = add_sphere(e["id"], float(g.get("radius", 0.5)), pos, mat)
        elif typ in {"box", "cube"} or g.get("shape") == "box":
            o = add_box(e["id"], g.get("dimensions", [1, 1, 1]), pos, mat)
        elif typ == "cylinder" or g.get("shape") == "cylinder":
            o = add_cylinder(e["id"], float(g.get("radius", 0.5)),
                             float(g.get("depth", 1.0)), pos, mat)
        elif typ == "plane" or g.get("shape") == "plane":
            o = add_plane(e["id"], float(g.get("size", 1.0)), pos, mat)
        elif typ == "empty":
            o = add_empty(e["id"], pos)
        else:
            # Unknown type — fall back to a placeholder cube so the scene stays visible.
            o = add_box(e["id"], [0.5, 0.5, 0.5], pos, mat)

        if o is not None:
            apply_transform(o, e.get("transform", {}))
            stamp_metadata(o, e)
            objs[e["id"]] = o

    # ── Second pass: parenting ──────────────────────────────────────
    for e in world["entities"]:
        parent_id = e.get("parent")
        if parent_id and parent_id in objs and e["id"] in objs:
            objs[e["id"]].parent = objs[parent_id]

    # ── Third pass: physics + behaviors ─────────────────────────────
    for e in world["entities"]:
        o = objs.get(e["id"])
        if o is None:
            continue
        rb = (e.get("physics", {}) or {}).get("rigid_body")
        if rb:
            add_rigid_body(o, rb)
        apply_behavior(e, o, objs, scene)

    # ── Fourth pass: events (keyframes) ─────────────────────────────
    print(f"WALLERMAX_EVENTS_COUNT: {len(world.get('events', []))} event(s) to apply")
    for ev in world.get("events", []):
        apply_event(ev, objs, scene)

    # ── Aesthetic compositor (always runs in cinematic mode) ────────
    # render.compositor = false skips the node-based compositor entirely
    # (for headless/GPU-less machines where Blender 5.x's compositor needs
    # an EGL context) — the vignette/grain then go through the ffmpeg
    # finishing pass instead.
    finish = {"vignette": False, "grain": False, "ca": False,
              "pending_vignette": None, "pending_grain": None}
    use_compositor = bool(render_cfg.get("compositor", True))
    if aesthetic or quality == "cinematic":
        if use_compositor:
            finish = setup_compositor(aesthetic, quality=quality,
                                      exposure_applied=exposure_applied) or finish
        else:
            print("WALLERMAX_COMPOSITOR_SKIP: disabled via world.render.compositor=false "
                  "(vignette/grain will be applied by the ffmpeg finishing pass)")
            if aesthetic.get("vignette"):
                finish["pending_vignette"] = max(0.05, min(1.0, float(aesthetic["vignette"])))
            if aesthetic.get("grain"):
                finish["pending_grain"] = max(0.0, min(1.0, float(aesthetic["grain"])))
            _apply_eevee_bloom(scene, aesthetic)

    # ── Summary: report what was animated ───────────────────────────
    anim_count = 0
    anim_details = []
    for obj_id, o in objs.items():
        # Check both the object's own animation_data AND its data block's
        # animation_data (lights have keyframes on their data, not on the object).
        obj_has_anim = o.animation_data and o.animation_data.action
        data_has_anim = False
        data = getattr(o, "data", None)
        if data is not None:
            data_anim = getattr(data, "animation_data", None)
            data_has_anim = data_anim is not None and data_anim.action is not None
        if obj_has_anim or data_has_anim:
            anim_count += 1
            fcurves_obj = len(_get_action_fcurves(o.animation_data.action)) if obj_has_anim else 0
            fcurves_data = len(_get_action_fcurves(data.animation_data.action)) if data_has_anim else 0
            anim_details.append(f"{obj_id}(obj:{fcurves_obj},data:{fcurves_data})")
    print(f"WALLERMAX_ANIMATED_OBJECTS: {anim_count} object(s) have keyframes")
    if anim_details:
        print(f"WALLERMAX_ANIMATED_DETAIL: {', '.join(anim_details)}")
    print(f"WALLERMAX_FRAME_RANGE: {scene.frame_start}..{scene.frame_end} at {scene.render.fps} fps")

    # ── Save & render ───────────────────────────────────────────────
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Configure Blender's NATIVE video output (produces MP4 directly,
    # no PNG intermediates, no external ffmpeg).
    # The diagnostic confirmed that Blender 5.2 LTS supports the classic
    # FFMPEG API:
    #   - image_settings.file_format accepts "FFMPEG" ✅
    #   - scene.render.ffmpeg has format/codec/constant_rate_factor ✅
    # So we use the classic API directly.
    mp4_path = setup_video_output(scene, out_dir, quality)

    bpy.ops.wm.save_as_mainfile(filepath=str(out_dir / "world.blend"))
    bpy.ops.render.render(animation=True)
    return finish


def setup_video_output(scene, out_dir, quality="standard"):
    """Configure Blender to produce an MP4 video file directly.

    Uses the FFMPEG API. In Blender 5.2, the diagnostic showed that
    `image_settings.file_format = "FFMPEG"` raises a TypeError even though
    "FFMPEG" appears in the enum items list. This is a known Blender quirk
    where the enum item exists for display purposes but can't be assigned.

    The workaround is to set `scene.render.ffmpeg.*` directly and catch
    the TypeError on `image_settings.file_format`. If the assignment raises,
    we try the alternative approach of just setting ffmpeg without touching
    image_settings.file_format (Blender auto-detects FFMPEG mode when
    ffmpeg.format is set).

    Returns the expected path of the produced MP4 file, or None if
    the PNG+ffmpeg fallback is needed.
    """
    out_dir = Path(out_dir)
    mp4_path = out_dir / "render.mp4"
    mp4_path_str = str(mp4_path).replace("\\", "/")

    # First, always configure scene.render.ffmpeg.* — this is needed
    # regardless of whether image_settings.file_format accepts "FFMPEG".
    try:
        scene.render.ffmpeg.format = "MPEG4"
        scene.render.ffmpeg.codec = "H264"
        # Cinematic renders get a visually lossless-ish CRF ("HIGH");
        # everything else keeps the historical "MEDIUM".
        scene.render.ffmpeg.constant_rate_factor = "HIGH" if quality == "cinematic" else "MEDIUM"
        print(f"WALLERMAX_VIDEO_API: ffmpeg.format={scene.render.ffmpeg.format} "
              f"codec={scene.render.ffmpeg.codec} crf={scene.render.ffmpeg.constant_rate_factor} "
              f"(quality={quality})")
    except (TypeError, AttributeError) as exc:
        print(f"WALLERMAX_VIDEO_API: ffmpeg config raised {exc}")

    # Now try to set image_settings.file_format = "FFMPEG".
    # In Blender 5.2, this RAISES a TypeError even though "FFMPEG" is
    # listed in the enum items. We catch the exception and try alternative
    # approaches.
    ffmpeg_set = False
    try:
        scene.render.image_settings.file_format = "FFMPEG"
        actual = scene.render.image_settings.file_format
        if actual == "FFMPEG":
            ffmpeg_set = True
            print(f"WALLERMAX_VIDEO_API: image_settings.file_format = FFMPEG ✅")
        else:
            print(f"WALLERMAX_VIDEO_API: image_settings.file_format stayed as '{actual}'")
    except TypeError as exc:
        # The assignment raised TypeError. The error message says
        # "enum FFMPEG not found in (...)" even though the diagnostic
        # showed it IS in the list. This is a Blender 5.2 bug/quirk.
        #
        # WORKAROUND: In Blender 5.2, setting scene.render.ffmpeg.*
        # is enough to tell Blender to produce a video file. The
        # image_settings.file_format doesn't need to be "FFMPEG" —
        # Blender checks ffmpeg.format internally during render.
        #
        # We leave image_settings.file_format as whatever it is (PNG)
        # and rely on scene.render.ffmpeg being configured.
        print(f"WALLERMAX_VIDEO_API: image_settings.file_format raised TypeError "
              f"(Blender 5.2 quirk — FFMPEG is listed but not assignable)")
        print(f"WALLERMAX_VIDEO_API: trying workaround — rely on scene.render.ffmpeg only")
        # If ffmpeg.format was set successfully above, we consider FFMPEG mode active.
        if scene.render.ffmpeg.format == "MPEG4":
            ffmpeg_set = True
            print(f"WALLERMAX_VIDEO_API: FFMPEG mode active via ffmpeg.format=MPEG4 ✅")

    if ffmpeg_set:
        # Set the filepath WITHOUT the .mp4 extension.
        # If Blender is in FFMPEG mode → produces render.mp4 directly.
        # If Blender falls back to PNG → produces render0001.png (with
        #   use_file_extension=True appending .png automatically).
        scene.render.filepath = mp4_path_str.replace(".mp4", "")
        # Keep use_file_extension=True so Blender appends .png to each
        # frame when in PNG mode. This way the frames are named
        # "render0001.png" (not "render0001" without extension).
        try:
            scene.render.use_file_extension = True
        except (AttributeError, TypeError):
            pass
        # Also make sure image_settings.file_format is PNG (the default)
        # so that if FFMPEG mode doesn't work, we get PNGs we can encode.
        try:
            scene.render.image_settings.file_format = "PNG"
        except (TypeError, AttributeError):
            pass
        print(f"WALLERMAX_VIDEO_API: native_ffmpeg — output_prefix={scene.render.filepath}")
        return mp4_path

    # Fallback: PNG sequence + external ffmpeg
    print(f"WALLERMAX_VIDEO_API: falling back to PNG sequence + ffmpeg")
    setup_png_sequence_output(scene, out_dir)
    return None


def setup_png_sequence_output(scene, out_dir):
    """Configure the scene to render a PNG image sequence.

    The frames will be saved as <out_dir>/frame_0001.png, frame_0002.png, ...
    After the render, main() will call _encode_frame_sequence_to_mp4() to
    combine them into a single MP4 using ffmpeg.
    """
    # Use forward slashes even on Windows — Blender accepts them and they
    # avoid backslash escaping issues.
    out_dir_str = str(out_dir).replace("\\", "/")
    try:
        scene.render.image_settings.file_format = "PNG"
        # The filepath is a prefix; Blender appends "0001.png", "0002.png", ...
        # We use forward slashes and NO trailing slash.
        scene.render.filepath = out_dir_str + "/frame_"
        # PNG color depth: 8-bit is fine for previews and keeps files small.
        try:
            scene.render.image_settings.color_mode = "RGB"
            scene.render.image_settings.color_depth = "8"
        except (AttributeError, TypeError):
            pass
        # Disable the auto-extension so we control the exact filename.
        # Actually, leave it enabled — Blender needs it to append .png.
        scene.render.use_file_extension = True
        # Compression: 0 = no compression (fastest), 100 = max compression.
        # 15 is a good trade-off (Blender's default).
        try:
            scene.render.image_settings.compression = 15
        except (AttributeError, TypeError):
            pass
        print(f"WALLERMAX_VIDEO_API: png_sequence — folder={out_dir} prefix=frame_")
    except (TypeError, AttributeError) as exc:
        # If even PNG fails (very unlikely), let Blender use its defaults.
        print(f"WALLERMAX_VIDEO_API_WARN: could not configure PNG output ({exc})")
        scene.render.filepath = out_dir_str + "/frame_"


def main():
    try:
        args = cli_args()
        if len(args) < 2:
            raise RuntimeError("Usage: blender -b --python build_scene.py -- world.json output_dir")
        world_path = Path(args[0]).resolve()
        out_dir = Path(args[1]).resolve()
        print(f"WALLERMAX_START: world={world_path} out={out_dir}")
        world = json.loads(world_path.read_text(encoding="utf-8"))
        print(f"WALLERMAX_WORLD_LOADED: version={world.get('version')} entities={len(world.get('entities', []))}")
        clear_scene()
        finish = compile_world(world, out_dir)
        # Verify outputs exist before declaring success. If the render
        # silently failed, we want to exit with a non-zero code so the
        # TypeScript orchestrator can surface the error.
        blend_path = out_dir / "world.blend"
        mp4_path = out_dir / "render.mp4"
        if not blend_path.exists():
            raise RuntimeError(f"world.blend was not produced at {blend_path}")
        # If Blender produced the MP4 natively (setup_video_output returned
        # a non-None path), we're done — no need to encode PNGs.
        # If it fell back to PNG sequence, we need to encode them with ffmpeg.
        if not mp4_path.exists():
            # Look for PNG frames to encode. The frames can be named:
            #   - frame_0001.png   (from setup_png_sequence_output)
            #   - render0001.png   (from the native_ffmpeg workaround when
            #                       Blender falls back to PNG despite
            #                       ffmpeg.format being set)
            #   - render.mp40001.png (old bug, kept for backwards compat)
            import re as _re
            frame_seq = sorted(out_dir.glob("frame_*.png"))
            if not frame_seq:
                frame_seq = sorted(out_dir.glob("render*.png"))
                # Filter to only frames that look like render0001.png
                # (not render.mp4 or render.mp4.png)
                if frame_seq:
                    frame_seq = [p for p in frame_seq
                                 if _re.search(r"render\d+\.png$", p.name)]
                    if frame_seq:
                        print(f"WALLERMAX_RENDER_FRAMES: detected {len(frame_seq)} "
                              f"frames named 'render*.png' — will encode them to MP4")
            if not frame_seq:
                frame_seq = sorted(out_dir.glob("frame*.png"))
            if not frame_seq:
                # Stray frames from the old filepath bug: "render.mp40001.png" etc.
                stray = sorted(out_dir.glob("render.mp4*.png"))
                frame_seq = [p for p in stray if _re.search(r"render\.mp4\d+\.png$", p.name)]
                if frame_seq:
                    print(f"WALLERMAX_STRAY_FRAMES: detected {len(frame_seq)} stray frames "
                          f"named 'render.mp4*.png' (old filepath bug) — will encode them to MP4")
            # Also look for frames WITHOUT extension (render0001, render0002, ...)
            # which happens when use_file_extension=False.
            if not frame_seq:
                no_ext = sorted(out_dir.glob("render[0-9]*"))
                if no_ext:
                    # These are frames without .png extension. Rename them to .png
                    # so ffmpeg can process them.
                    print(f"WALLERMAX_NO_EXT_FRAMES: detected {len(no_ext)} frames "
                          f"without extension — renaming to .png")
                    for f in no_ext:
                        png_name = str(f) + ".png"
                        try:
                            _os.rename(str(f), png_name)
                        except OSError:
                            pass
                    frame_seq = sorted(out_dir.glob("render[0-9]*.png"))
            if frame_seq:
                print(f"WALLERMAX_ENCODE_FRAMES: found {len(frame_seq)} PNG frames, encoding to MP4")
                _encode_frame_sequence_to_mp4(frame_seq, mp4_path, world)
        # Final verification.
        if not mp4_path.exists():
            # List what's in the output dir to help diagnosis.
            try:
                files_in_dir = sorted(p.name for p in out_dir.iterdir())[:20]
                print(f"WALLERMAX_DIR_CONTENTS (first 20): {files_in_dir}")
            except Exception:
                pass
            raise RuntimeError(
                f"render.mp4 was not produced at {mp4_path}. "
                f"The render may have failed, or ffmpeg could not encode the frames."
            )
        print(f"WALLERMAX_BLEND_OK: {blend_path}")
        print(f"WALLERMAX_RENDER_OK: {mp4_path}")
        # Finishing pass: runs when world.render.postprocess = true, or
        # automatically in cinematic mode when the compositor could not
        # apply the vignette/grain (e.g. Blender 5.2 removed the mix
        # nodes) — ffmpeg's vignette/noise filters take over.
        render_cfg = (world.get("world", {}) or {}).get("render", {}) or {}
        q_str = str(render_cfg.get("quality", "standard")).strip().lower()
        pending_finish = finish and (
            finish.get("pending_vignette") is not None or
            finish.get("pending_grain") is not None
        )
        if render_cfg.get("postprocess") or pending_finish:
            _postprocess_video(mp4_path, q_str, finish or {})
        # Clean up PNG frames after successful MP4 encoding to save disk space.
        import os as _os
        import re as _re_cleanup
        for f in out_dir.iterdir():
            name = f.name
            # Match frame_*.png, frame*.png, render*.png (with digits), render.mp4*.png
            if name.endswith(".png") and (
                name.startswith("frame_") or
                name.startswith("frame") or
                _re_cleanup.match(r"render\d+\.png$", name) or
                _re_cleanup.match(r"render\.mp4\d+\.png$", name)
            ):
                try:
                    _os.remove(str(f))
                except OSError:
                    pass
        # Also clean up frames without extension (render0001, render0002, ...)
        for f in out_dir.iterdir():
            if _re_cleanup.match(r"render\d+$", f.name):
                try:
                    _os.remove(str(f))
                except OSError:
                    pass
        print(f"WALLERMAX_CLEANUP_PNG: removed intermediate frames")
    except Exception as exc:
        # Print the full traceback to stderr so the TypeScript orchestrator
        # can capture it and show it to the user. Blender's background mode
        # sometimes swallows exceptions, so we use sys.exit to force a
        # non-zero exit code.
        import traceback
        print(f"WALLERMAX_ERROR: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


def _encode_frame_sequence_to_mp4(frame_paths, mp4_path, world):
    """Encode a PNG frame sequence into an MP4 using ffmpeg (system or bundled).

    Used as a last-resort fallback when Blender 5.x's new video output API
    doesn't produce a file directly. We re-use the same encoder-selection
    logic as the fallback renderer.

    Handles two frame naming patterns:
      - "frame_0001.png"  → pattern "frame_%04d.png"
      - "render.mp40001.png" (stray frames from the old filepath bug) →
        pattern "render.mp4%04d.png"
    """
    import subprocess
    import shutil
    import os as _os
    # Determine fps from the World Model (or default to 30).
    render_block = (world.get("world", {}) or {}).get("render", {}) or {}
    fps = int(render_block.get("fps", 30))
    quality = str(render_block.get("quality", "standard")).strip().lower()
    # Use the first frame as the input pattern.
    first = frame_paths[0]
    # Build the ffmpeg input pattern by replacing the digit run in the
    # FILENAME ONLY with %04d. We must NOT do this on the full path because
    # the path may contain other digits (e.g. "wallermax-h1" in the project
    # folder name) that would get replaced by mistake.
    import re
    import os
    # Normalize to forward slashes for consistent splitting on all platforms.
    first_str = str(first).replace("\\", "/")
    # Split into directory + filename using the OS-agnostic forward slash.
    if "/" in first_str:
        dir_part, name = first_str.rsplit("/", 1)
    else:
        dir_part, name = "", first_str
    # Replace the longest digit run in the filename with %04d.
    name_pattern = re.sub(r"\d+", "%04d", name, count=1)
    pattern = (dir_part + "/" + name_pattern) if dir_part else name_pattern
    print(f"WALLERMAX_ENCODE_FRAMES_PATTERN: first={first_str} → pattern={pattern}")
    # Probe available encoders (same logic as fallback_renderer.py).
    # We try multiple ffmpeg binaries in order:
    #   1. Blender's bundled ffmpeg (always has libx264). We find it by
    #      looking next to the Blender executable.
    #   2. The system ffmpeg on PATH.
    ffmpeg_bin = _find_best_ffmpeg()
    print(f"WALLERMAX_FFMPEG_BIN: {ffmpeg_bin}")
    try:
        encoders_out = subprocess.run(
            [ffmpeg_bin, "-hide_banner", "-encoders"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True,
        ).stdout.decode("utf-8", errors="replace")
    except Exception:
        encoders_out = ""
    encoders = set()
    for line in encoders_out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and line.startswith(" V"):
            encoders.add(parts[1])
    print(f"WALLERMAX_FFMPEG_ENCODERS: {sorted(encoders)}")

    # ── Build a list of (encoder_name, cmd_args, label) candidates in order
    # of preference. We'll try each one with a 1-frame test encode and pick
    # the first that actually works.
    #
    # This is critical because some ffmpeg builds list encoders (like
    # h264_nvenc) but fail at runtime when the hardware (e.g. NVIDIA GPU)
    # is not present. The previous code would pick h264_nvenc and then fail
    # with "Cannot load nvcuda.dll" — producing a 0-byte MP4 that no player
    # can open.
    faststart = ["-movflags", "+faststart"]
    candidates = []
    if "libx264" in encoders:
        candidates.append((
            "libx264",
            ["-c:v", "libx264", "-pix_fmt", "yuv420p",
             "-crf", ("16" if quality == "cinematic" else "20"),
             "-preset", ("slow" if quality == "cinematic" else "medium")] + faststart,
            "libx264 (H.264 software — universally supported by browsers)",
        ))
    if "h264_qsv" in encoders:
        candidates.append((
            "h264_qsv",
            ["-c:v", "h264_qsv", "-pix_fmt", "yuv420p",
             "-global_quality", "22"] + faststart,
            "h264_qsv (H.264 Intel QuickSync)",
        ))
    if "h264_amf" in encoders:
        candidates.append((
            "h264_amf",
            ["-c:v", "h264_amf", "-pix_fmt", "yuv420p",
             "-quality", "balanced"] + faststart,
            "h264_amf (H.264 AMD AMF)",
        ))
    if "h264_nvenc" in encoders:
        candidates.append((
            "h264_nvenc",
            ["-c:v", "h264_nvenc", "-pix_fmt", "yuv420p",
             "-preset", "p4", "-rc", "vbr", "-cq", "22"] + faststart,
            "h264_nvenc (H.264 NVIDIA GPU)",
        ))
    if "libx265" in encoders:
        candidates.append((
            "libx265",
            ["-c:v", "libx265", "-pix_fmt", "yuv420p",
             "-crf", "24", "-preset", "medium", "-tag:v", "hvc1"] + faststart,
            "libx265 (HEVC — may not play in all browsers)",
        ))
    if "mpeg4" in encoders:
        candidates.append((
            "mpeg4",
            ["-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-q:v", "5"] + faststart,
            "mpeg4 (MPEG-4 Part 2 — NOT playable inline in Chrome/Firefox)",
        ))

    if not candidates:
        print("WALLERMAX_ENCODE_FRAMES_WARN: no known encoder available; skipping")
        return

    # Try each candidate with a 1-frame test encode. The first one that
    # produces a valid MP4 (non-zero size, opens without errors) wins.
    chosen_encoder = None
    chosen_args = None
    chosen_label = None
    test_frame = frame_paths[0]
    test_mp4 = str(mp4_path) + ".test.mp4"
    for enc_name, enc_args, label in candidates:
        print(f"WALLERMAX_ENCODE_PROBE: testing encoder '{enc_name}' with 1 frame…")
        test_cmd = [ffmpeg_bin, "-y", "-loglevel", "error",
                    "-i", str(test_frame)] + enc_args + [test_mp4]
        try:
            test_result = subprocess.run(test_cmd, stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, timeout=30)
        except subprocess.TimeoutExpired:
            print(f"WALLERMAX_ENCODE_PROBE_FAIL: '{enc_name}' timed out")
            continue
        test_err = test_result.stderr.decode("utf-8", errors="replace")
        # Check that the test MP4 was actually created and is non-trivial.
        test_size = _os.path.getsize(test_mp4) if _os.path.exists(test_mp4) else 0
        try:
            _os.remove(test_mp4)
        except OSError:
            pass
        if test_result.returncode != 0 or test_size < 1000:
            # Encoder failed — log and try the next one.
            print(f"WALLERMAX_ENCODE_PROBE_FAIL: '{enc_name}' failed "
                  f"(exit={test_result.returncode}, size={test_size}b)")
            if test_err.strip():
                print(f"  stderr: {test_err.strip()[:300]}")
            continue
        # Success!
        chosen_encoder = enc_name
        chosen_args = enc_args
        chosen_label = label
        print(f"WALLERMAX_ENCODE_PROBE_OK: '{enc_name}' works (test size={test_size}b)")
        break

    if not chosen_encoder:
        print("WALLERMAX_ENCODE_FRAMES_FAIL: no encoder could produce a valid MP4.")
        print("  Tried all of: " + ", ".join(c[0] for c in candidates))
        print("  Last error from each probe is shown above.")
        return

    # Build the final command and run it.
    cmd = [ffmpeg_bin, "-y", "-loglevel", "error",
           "-framerate", str(fps), "-i", pattern] + chosen_args + [str(mp4_path)]
    print(f"WALLERMAX_ENCODE_CHOSEN: {chosen_label}")
    print(f"WALLERMAX_ENCODE_FRAMES_CMD: {' '.join(cmd)}")
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        err = result.stderr.decode("utf-8", errors="replace")
        print(f"WALLERMAX_ENCODE_FRAMES_FAIL: ffmpeg exit {result.returncode}\n{err}")
        # Clean up any partial MP4 so main()'s existence check fails.
        try:
            _os.remove(str(mp4_path))
        except OSError:
            pass
        return
    # Verify the MP4 is actually non-trivial (>1KB). An empty or 0-byte
    # MP4 would silently "succeed" (exit 0) but be unplayable.
    final_size = _os.path.getsize(str(mp4_path)) if _os.path.exists(str(mp4_path)) else 0
    if final_size < 1000:
        print(f"WALLERMAX_ENCODE_FRAMES_FAIL: MP4 is too small ({final_size} bytes) — "
              f"encoder produced no real data")
        try:
            _os.remove(str(mp4_path))
        except OSError:
            pass
        return
    print(f"WALLERMAX_ENCODE_FRAMES_OK: {mp4_path} ({final_size} bytes)")


def _postprocess_video(mp4_path, quality="standard", pending=None):
    """Finishing pass on the final MP4 (sharpen + micro grade, always;
    vignette + temporal film grain when the compositor could not apply
    them — e.g. on Blender 5.2 where the mix nodes were removed).

    Deterministic; skipped (with a log) if no ffmpeg can produce a valid
    output. The graded file atomically replaces the original only when it
    is verified to be non-trivial.
    """
    import subprocess
    import os as _os
    pending = pending or {}
    # unsharp syntax: luma_msize_x:luma_msize_y:luma_amount (odd sizes >= 3)
    filters = ["unsharp=5:5:0.35", "eq=contrast=1.02:saturation=1.04"]
    pv = pending.get("pending_vignette")
    if pv is not None:
        # ffmpeg 'vignette' angle: 0..PI/2, larger = darker corners.
        angle = (0.6 + max(0.05, min(1.0, float(pv)))) * math.pi / 5.0
        filters.append(f"vignette=angle={angle:.5f}")
    pg = pending.get("pending_grain")
    if pg is not None:
        # 'allf=t' = temporal (new noise every frame) = real film grain.
        alls = max(1, min(40, int(round(float(pg) * 30))))
        filters.append(f"noise=alls={alls}:allf=t")
    vf = ",".join(filters)
    ffmpeg_bin = _find_best_ffmpeg()
    tmp = str(mp4_path) + ".graded.mp4"
    crf = "16" if quality == "cinematic" else "18"
    cmd = [ffmpeg_bin, "-y", "-loglevel", "error",
           "-i", str(mp4_path),
           "-vf", vf,
           "-c:v", "libx264", "-pix_fmt", "yuv420p",
           "-crf", crf, "-preset", "medium", "-movflags", "+faststart",
           tmp]
    print(f"WALLERMAX_POSTPROCESS_CMD: {' '.join(cmd)}")
    try:
        result = subprocess.run(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=600)
    except subprocess.TimeoutExpired:
        print("WALLERMAX_POSTPROCESS_FAIL: timeout")
        return
    err = result.stderr.decode("utf-8", errors="replace")
    ok_size = _os.path.getsize(tmp) if _os.path.exists(tmp) else 0
    if result.returncode != 0 or ok_size < 1000:
        print(f"WALLERMAX_POSTPROCESS_FAIL: exit={result.returncode} "
              f"size={ok_size}b\n{err[:300]}")
        try:
            _os.remove(tmp)
        except OSError:
            pass
        return
    _os.replace(tmp, str(mp4_path))
    print(f"WALLERMAX_POSTPROCESS_OK: {mp4_path} ({ok_size} bytes, crf={crf})")


def _find_best_ffmpeg():
    """Find the best available ffmpeg binary.

    Returns the path to the ffmpeg binary we should use, in order of preference:
      1. Blender's bundled ffmpeg (always has libx264) — found next to
         bpy.app.binary_path (the Blender executable).
      2. The system ffmpeg on PATH.

    Blender ships with its own build of ffmpeg that includes libx264, h264_nvenc,
    and other encoders. This is the most reliable way to get a browser-playable
    MP4 without asking the user to install anything extra.
    """
    import shutil as _shutil
    import os as _os
    # 1. Try Blender's bundled ffmpeg.
    # On Windows, it's at <blender_dir>/ffmpeg.exe.
    # On macOS, it's at <blender_dir>/../Resources/bin/ffmpeg (inside the .app).
    # On Linux, it's at <blender_dir>/ffmpeg.
    try:
        blender_bin = bpy.app.binary_path
        blender_dir = _os.path.dirname(blender_bin)
        candidates = [
            _os.path.join(blender_dir, "ffmpeg.exe"),
            _os.path.join(blender_dir, "ffmpeg"),
            # macOS .app bundle structure:
            _os.path.join(blender_dir, "..", "Resources", "bin", "ffmpeg"),
            # Some builds put it in a "bin" subdirectory:
            _os.path.join(blender_dir, "bin", "ffmpeg.exe"),
            _os.path.join(blender_dir, "bin", "ffmpeg"),
        ]
        for cand in candidates:
            cand = _os.path.normpath(cand)
            if _os.path.isfile(cand):
                # Verify it actually runs (some Blender builds ship a stub).
                try:
                    r = subprocess.run([cand, "-version"], stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, check=True, timeout=5)
                    if b"ffmpeg" in r.stdout.lower():
                        return cand
                except Exception:
                    pass
    except Exception as exc:
        print(f"WALLERMAX_FFMPEG_BIN_WARN: could not probe Blender's ffmpeg ({exc})")
    # 2. Fall back to the system ffmpeg on PATH.
    sys_ff = _shutil.which("ffmpeg") or "ffmpeg"
    return sys_ff


if __name__ == "__main__":
    main()
