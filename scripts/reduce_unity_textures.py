#!/usr/bin/env python3
"""Reduce Unity texture and graphics quality inside an unpacked APK and/or OBB.

Two complementary mechanisms:
1. QualitySettings patching (fast, safe, lossless to file format):
   Sets Unity's `globalTextureMipmapLimit` / `masterTextureLimit`, disables MSAA,
   lowers shadows, disables anisotropic filtering and realtime reflection probes.
   This immediately reduces GPU/VRAM usage on Android phones with zero codec risk.
2. Optional physical Texture2D downscaling (`--max-texture-size > 0`):
   Uses UnityPy + Pillow to downscale oversized Texture2D assets in `.assets` and
   `.bundle` files.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

QUALITY_PRESETS: Dict[str, Dict[str, Any]] = {
    "original": {},
    "medium": {
        "mipmap_limit": 1,  # 1/2 resolution (25% pixels)
        "antiAliasing": 0,
        "anisotropicTextures": 0,
        "shadowResolution": 0,
        "pixelLightCount": 2,
        "softParticles": False,
        "realtimeReflectionProbes": False,
    },
    "low": {
        "mipmap_limit": 2,  # 1/4 resolution (6.25% pixels)
        "antiAliasing": 0,
        "anisotropicTextures": 0,
        "shadows": 0,
        "shadowResolution": 0,
        "shadowCascades": 0,
        "pixelLightCount": 1,
        "softParticles": False,
        "realtimeReflectionProbes": False,
        "lodBias": 0.6,
    },
    "ultra_low": {
        "mipmap_limit": 3,  # 1/8 resolution
        "antiAliasing": 0,
        "anisotropicTextures": 0,
        "shadows": 0,
        "shadowResolution": 0,
        "shadowCascades": 0,
        "pixelLightCount": 0,
        "softParticles": False,
        "realtimeReflectionProbes": False,
        "lodBias": 0.4,
    },
}

SKIP_TEXTURE_KEYWORDS = (
    "font",
    "sdf",
    "lut",
    "lightmap",
    "brdf",
    "atlas_ui",
    "cursor",
)


def compute_target_dimensions(width: int, height: int, max_size: int) -> Optional[Tuple[int, int]]:
    """Return resized (new_w, new_h) preserving aspect ratio if larger than max_size."""
    if max_size <= 0 or width <= 0 or height <= 0:
        return None
    longest = max(width, height)
    if longest <= max_size:
        return None
    scale = max_size / float(longest)
    new_w = max(4, int(round(width * scale)))
    new_h = max(4, int(round(height * scale)))
    # Keep multiples of 4 for block-compressed mobile GPU formats (ASTC/ETC2/DXT)
    new_w = max(4, (new_w // 4) * 4)
    new_h = max(4, (new_h // 4) * 4)
    return new_w, new_h


def apply_quality_preset_to_tree(tree: Dict[str, Any], preset_name: str) -> int:
    """Mutate a Unity QualitySettings typetree dict in-place. Returns modified level count."""
    preset = QUALITY_PRESETS.get(preset_name, {})
    if not preset:
        return 0

    levels = tree.get("m_QualitySettings")
    if not isinstance(levels, list):
        return 0

    modified_levels = 0
    mipmap_limit = preset.get("mipmap_limit")

    for level in levels:
        if not isinstance(level, dict):
            continue
        changed = False
        if mipmap_limit is not None:
            # Unity 2022.2+ renamed masterTextureLimit -> globalTextureMipmapLimit
            if "globalTextureMipmapLimit" in level:
                level["globalTextureMipmapLimit"] = int(mipmap_limit)
                changed = True
            if "masterTextureLimit" in level:
                level["masterTextureLimit"] = int(mipmap_limit)
                changed = True

        for key in (
            "antiAliasing",
            "anisotropicTextures",
            "shadows",
            "shadowResolution",
            "shadowCascades",
            "pixelLightCount",
            "softParticles",
            "realtimeReflectionProbes",
            "lodBias",
        ):
            if key in preset and key in level:
                level[key] = preset[key]
                changed = True

        if changed:
            modified_levels += 1

    return modified_levels


def _should_skip_texture(name: str) -> bool:
    lower = (name or "").lower()
    return any(kw in lower for kw in SKIP_TEXTURE_KEYWORDS)


def process_unity_directory(
    data_dir: Path,
    preset_name: str,
    max_texture_size: int = 0,
) -> Dict[str, int]:
    """Patch Unity QualitySettings and optionally downscale Texture2D assets in `data_dir`."""
    stats = {
        "files_scanned": 0,
        "files_modified": 0,
        "quality_levels_patched": 0,
        "textures_downscaled": 0,
        "textures_skipped": 0,
        "errors": 0,
    }

    if preset_name == "original" and max_texture_size <= 0:
        return stats

    if not data_dir.exists():
        return stats

    import UnityPy
    from UnityPy.helpers import TypeTreeHelper
    from PIL import Image

    # Avoid rare native C typetree reader crashes on certain Unity versions
    TypeTreeHelper.read_typetree_c = False

    candidates: List[Path] = []
    for root, _, filenames in os.walk(data_dir):
        for fn in filenames:
            p = Path(root) / fn
            lower = fn.lower()
            is_quality_file = lower == "globalgamemanagers"
            is_asset_file = (
                lower.endswith(".assets")
                or lower.endswith(".bundle")
                or lower.endswith(".unity3d")
                or lower.startswith("sharedassets")
                or lower.startswith("level")
            )
            if is_quality_file or (max_texture_size > 0 and is_asset_file):
                if not lower.endswith(".ress") and not lower.endswith(".resource"):
                    candidates.append(p)

    for asset_path in sorted(candidates):
        stats["files_scanned"] += 1
        file_modified = False
        try:
            env = UnityPy.load(str(asset_path))
        except Exception as exc:
            print(f"[unity] Aviso: nao foi possivel abrir {asset_path.name}: {exc}")
            stats["errors"] += 1
            continue

        for obj in env.objects:
            type_name = getattr(obj.type, "name", str(obj.type))

            if type_name == "QualitySettings" and preset_name != "original":
                try:
                    tree = obj.read_typetree()
                    count = apply_quality_preset_to_tree(tree, preset_name)
                    if count > 0:
                        obj.save_typetree(tree)
                        stats["quality_levels_patched"] += count
                        file_modified = True
                except Exception as exc:
                    print(f"[unity] Aviso ao editar QualitySettings em {asset_path.name}: {exc}")
                    stats["errors"] += 1

            elif type_name == "Texture2D" and max_texture_size > 0:
                try:
                    data = obj.read()
                    tex_name = getattr(data, "m_Name", "") or getattr(data, "name", "")
                    if _should_skip_texture(tex_name):
                        stats["textures_skipped"] += 1
                        continue
                    width = int(getattr(data, "m_Width", 0))
                    height = int(getattr(data, "m_Height", 0))
                    target = compute_target_dimensions(width, height, max_texture_size)
                    if target is None:
                        stats["textures_skipped"] += 1
                        continue

                    img = data.image
                    if img is None:
                        stats["textures_skipped"] += 1
                        continue
                    resized = img.resize(target, Image.Resampling.LANCZOS)
                    data.image = resized
                    data.save()
                    stats["textures_downscaled"] += 1
                    file_modified = True
                except Exception:
                    stats["textures_skipped"] += 1

        if file_modified:
            try:
                saved = False
                for _, unity_file in env.files.items():
                    raw = unity_file.save()
                    if isinstance(raw, (bytes, bytearray)) and len(raw) > 0:
                        asset_path.write_bytes(raw)
                        saved = True
                        break
                if saved:
                    stats["files_modified"] += 1
            except Exception as exc:
                print(f"[unity] Aviso ao salvar {asset_path.name}: {exc}")
                stats["errors"] += 1

    return stats


def process_obb_archive(
    obb_in: Path,
    obb_out: Path,
    preset_name: str,
    max_texture_size: int = 0,
) -> Dict[str, int]:
    """Unpack a ZIP-based Unity OBB, optimize Unity assets, and repack cleanly."""
    if not zipfile.is_zipfile(obb_in):
        print(f"[unity] OBB {obb_in.name} nao e arquivo ZIP padrao; copiando sem alteracao.")
        obb_out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(obb_in, obb_out)
        return {"files_scanned": 0, "files_modified": 0, "quality_levels_patched": 0, "textures_downscaled": 0, "textures_skipped": 0, "errors": 0}

    with tempfile.TemporaryDirectory(prefix="obb_opt_") as tmp:
        tmp_dir = Path(tmp)
        extract_dir = tmp_dir / "extracted"
        compress_map: Dict[str, int] = {}

        with zipfile.ZipFile(obb_in, "r") as zin:
            for info in zin.infolist():
                compress_map[info.filename] = info.compress_type
            zin.extractall(extract_dir)

        data_root = extract_dir / "assets" / "bin" / "Data"
        target_dir = data_root if data_root.exists() else extract_dir
        stats = process_unity_directory(target_dir, preset_name, max_texture_size)

        obb_out.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(obb_out, "w") as zout:
            for root, _, filenames in os.walk(extract_dir):
                for fn in sorted(filenames):
                    full = Path(root) / fn
                    rel = full.relative_to(extract_dir).as_posix()
                    ctype = compress_map.get(rel, zipfile.ZIP_STORED)
                    zout.write(full, arcname=rel, compress_type=ctype)

        return stats


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Reduz qualidade grafica e texturas em jogos Unity (APK/OBB).")
    parser.add_argument("--apk-unpacked-dir", default="", help="Diretorio do APK descompactado pelo apktool")
    parser.add_argument("--obb-in", default="", help="Caminho do arquivo .obb de entrada")
    parser.add_argument("--obb-out", default="", help="Caminho do arquivo .obb de saida")
    parser.add_argument(
        "--preset",
        choices=sorted(QUALITY_PRESETS.keys()),
        default="low",
        help="Nivel de qualidade Unity QualitySettings",
    )
    parser.add_argument(
        "--max-texture-size",
        type=int,
        default=0,
        help="Resolucao maxima para Texture2D (0 = somente mipmap QualitySettings, mais seguro)",
    )
    parser.add_argument("--stats-out", default="", help="Opcional: salvar resumo JSON")
    args = parser.parse_args(argv)

    summary: Dict[str, Any] = {
        "preset": args.preset,
        "max_texture_size": args.max_texture_size,
        "apk_stats": None,
        "obb_stats": None,
    }

    if args.apk_unpacked_dir:
        apk_data = Path(args.apk_unpacked_dir) / "assets" / "bin" / "Data"
        if apk_data.exists():
            print(f"[unity] Otimizando assets Unity no APK ({apk_data})...")
            summary["apk_stats"] = process_unity_directory(apk_data, args.preset, args.max_texture_size)
        else:
            print("[unity] Pasta assets/bin/Data nao encontrada no APK (assets podem estar no OBB).")

    if args.obb_in and args.obb_out:
        obb_in = Path(args.obb_in)
        obb_out = Path(args.obb_out)
        if obb_in.exists():
            print(f"[unity] Otimizando OBB {obb_in.name}...")
            summary["obb_stats"] = process_obb_archive(obb_in, obb_out, args.preset, args.max_texture_size)

    print(json.dumps(summary, indent=2))
    if args.stats_out:
        Path(args.stats_out).write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
