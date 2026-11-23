#!/usr/bin/env python3
"""Analyze and patch a Meta Quest / OpenXR APK to run on Android phones with Monado OpenXR.

What this tool does:
1. Analyzes the APK (ABIs, Unity/Unreal engine, OpenXR vs VrApi, Meta vs Khronos loader).
2. Patches AndroidManifest.xml:
   - Makes Quest-only <uses-feature> flags optional (required="false") so phones allow install.
   - Adds <queries> for Khronos OpenXR Runtime Broker and Monado OpenXR services (Android 11+).
   - Adds android.intent.category.LAUNCHER to the MAIN VR activity so it appears on the phone.
   - Sets android:extractNativeLibs="true" on <application>.
3. Replaces Meta's proprietary libopenxr_loader.so with the official Khronos OpenXR Loader
   extracted from Maven Central's `org.khronos.openxr:openxr_loader_for_android` AAR.
4. Optionally calls `reduce_unity_textures.py` to lower Unity QualitySettings / Texture2D resolution.
5. Rebuilds, zipaligns, and signs the APK with apksigner.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

ANDROID_NS = "http://schemas.android.com/apk/res/android"
TOOLS_NS = "http://schemas.android.com/tools"
A_NAME = f"{{{ANDROID_NS}}}name"
A_REQUIRED = f"{{{ANDROID_NS}}}required"
A_AUTHORITIES = f"{{{ANDROID_NS}}}authorities"
A_EXTRACT_NATIVE_LIBS = f"{{{ANDROID_NS}}}extractNativeLibs"

OPTIONAL_FEATURE_PREFIXES = (
    "oculus.software.",
    "com.oculus.feature.",
    "com.meta.xr.",
    "fb.software.",
    "android.hardware.vr.",
)

OPENXR_QUERY_ACTIONS = (
    "org.khronos.openxr.OpenXRRuntimeService",
    "org.khronos.openxr.OpenXRApiLayerService",
)

OPENXR_QUERY_PROVIDERS = (
    "org.khronos.openxr.runtime_broker",
    "org.khronos.openxr.system_runtime_broker",
)

OPENXR_QUERY_PACKAGES = (
    "org.khronos.openxr.runtime_broker",
    "org.freedesktop.monado.openxr_runtime.out_of_process",
    "org.freedesktop.monado.openxr_runtime.in_process",
)

VR_LAUNCHER_CATEGORIES = {
    "com.oculus.intent.category.VR",
    "org.khronos.openxr.intent.category.IMMERSIVE_HMD",
    "com.google.intent.category.DAYDREAM",
    "com.google.intent.category.CARDBOARD",
}


def analyze_apk(apk_path: Path) -> Dict[str, Any]:
    """Inspect an APK zip and return a structured compatibility analysis."""
    abis: Set[str] = set()
    native_libs: Set[str] = set()
    loader_vendor = "none"
    has_unity_data = False
    has_il2cpp = False
    has_mono = False
    has_unreal = False
    has_openxr_loader = False
    has_unity_openxr = False
    has_ovr_plugin = False
    has_vrapi = False
    has_ovr_platform = False
    meta_extensions_hint: List[str] = []

    with zipfile.ZipFile(apk_path, "r") as zf:
        for info in zf.infolist():
            name = info.filename
            if name.startswith("lib/") and name.endswith(".so"):
                parts = name.split("/")
                if len(parts) >= 3:
                    abis.add(parts[1])
                    lib_name = parts[-1]
                    native_libs.add(lib_name)

                    if lib_name == "libil2cpp.so":
                        has_il2cpp = True
                    elif lib_name in ("libmono.so", "libmonobdwgc-2.0.so"):
                        has_mono = True
                    elif lib_name in ("libUE4.so", "libUnreal.so"):
                        has_unreal = True
                    elif lib_name == "libopenxr_loader.so":
                        has_openxr_loader = True
                        raw = zf.read(name)
                        if b"org.khronos.openxr.runtime_broker" in raw or b"OpenXRRuntimeService" in raw:
                            loader_vendor = "khronos"
                        elif b"oculus" in raw.lower() or b"meta" in raw.lower():
                            loader_vendor = "meta_proprietary"
                        else:
                            loader_vendor = "unknown"
                    elif lib_name == "libUnityOpenXR.so":
                        has_unity_openxr = True
                    elif lib_name == "libOVRPlugin.so":
                        has_ovr_plugin = True
                        raw = zf.read(name)
                        for ext in (
                            b"XR_EXT_hand_tracking",
                            b"XR_FB_passthrough",
                            b"XR_META_body_tracking",
                            b"XR_FB_hand_tracking_mesh",
                        ):
                            if ext in raw:
                                ext_str = ext.decode("ascii")
                                if ext_str not in meta_extensions_hint:
                                    meta_extensions_hint.append(ext_str)
                    elif lib_name == "libvrapi.so":
                        has_vrapi = True
                    elif lib_name == "libovrplatformloader.so":
                        has_ovr_platform = True

            if name.startswith("assets/bin/Data/"):
                has_unity_data = True

    if has_il2cpp:
        engine = "Unity (IL2CPP)"
    elif has_mono:
        engine = "Unity (Mono)"
    elif has_unreal:
        engine = "Unreal Engine"
    elif has_unity_data:
        engine = "Unity"
    else:
        engine = "Desconhecido / Nativo"

    warnings: List[str] = []
    if "arm64-v8a" in abis and "armeabi-v7a" not in abis:
        warnings.append(
            "APK e somente 64 bits (arm64-v8a): funciona em celulares Android 64-bit, mas nao em aparelhos 32-bit."
        )
    if has_vrapi and not has_openxr_loader:
        warnings.append(
            "APK usa VrApi legado (sem OpenXR): precisa de uma camada VrApi->OpenXR como a do PhoneXR."
        )
    if loader_vendor == "meta_proprietary":
        warnings.append(
            "Detectado libopenxr_loader.so proprietario da Meta: a troca pelo loader oficial da Khronos e obrigatoria para conectar ao Monado."
        )
    if has_ovr_platform:
        warnings.append(
            "Detectado libovrplatformloader.so (Meta Platform SDK): o jogo pode fazer verificacao de licenca/perfil da Meta ao abrir fora de um Quest."
        )
    if not has_openxr_loader and has_ovr_plugin:
        warnings.append(
            "Detectado libOVRPlugin.so sem libopenxr_loader.so separado: o loader Khronos sera adicionado, mas o plugin pode exigir extensoes especificas da Meta."
        )

    return {
        "apk_name": apk_path.name,
        "apk_size_mb": round(apk_path.stat().st_size / (1024 * 1024), 2),
        "abis": sorted(abis),
        "engine": engine,
        "has_unity_data": has_unity_data,
        "has_openxr_loader": has_openxr_loader,
        "openxr_loader_vendor": loader_vendor,
        "has_unity_openxr": has_unity_openxr,
        "has_ovr_plugin": has_ovr_plugin,
        "has_vrapi": has_vrapi,
        "has_ovr_platform": has_ovr_platform,
        "extensions_hint": sorted(meta_extensions_hint),
        "warnings": warnings,
    }


def patch_manifest_xml(manifest_path: Path) -> Dict[str, Any]:
    """Patch decoded AndroidManifest.xml in-place for phone + Monado OpenXR compatibility."""
    ET.register_namespace("android", ANDROID_NS)
    ET.register_namespace("tools", TOOLS_NS)

    tree = ET.parse(manifest_path)
    root = tree.getroot()

    changes = {
        "features_made_optional": [],
        "features_added": [],
        "queries_added": 0,
        "launcher_categories_added": 0,
        "extract_native_libs_set": False,
    }

    existing_features: Set[str] = set()
    for elem in root.findall("uses-feature"):
        feat_name = elem.get(A_NAME, "")
        existing_features.add(feat_name)
        if any(feat_name.startswith(prefix) for prefix in OPTIONAL_FEATURE_PREFIXES):
            if elem.get(A_REQUIRED) != "false":
                elem.set(A_REQUIRED, "false")
                changes["features_made_optional"].append(feat_name)

    for phone_feat in ("android.hardware.sensor.gyroscope", "android.hardware.camera"):
        if phone_feat not in existing_features:
            el = ET.Element("uses-feature")
            el.set(A_NAME, phone_feat)
            el.set(A_REQUIRED, "false")
            root.insert(0, el)
            changes["features_added"].append(phone_feat)

    # Ensure <queries> contains Khronos OpenXR Runtime Broker + Monado services/packages
    queries = root.find("queries")
    if queries is None:
        queries = ET.SubElement(root, "queries")

    existing_actions = {
        act.get(A_NAME, "")
        for intent in queries.findall("intent")
        for act in intent.findall("action")
    }
    for action_name in OPENXR_QUERY_ACTIONS:
        if action_name not in existing_actions:
            intent_el = ET.SubElement(queries, "intent")
            act_el = ET.SubElement(intent_el, "action")
            act_el.set(A_NAME, action_name)
            changes["queries_added"] += 1

    existing_providers = {prov.get(A_AUTHORITIES, "") for prov in queries.findall("provider")}
    for authority in OPENXR_QUERY_PROVIDERS:
        if authority not in existing_providers:
            prov_el = ET.SubElement(queries, "provider")
            prov_el.set(A_AUTHORITIES, authority)
            changes["queries_added"] += 1

    existing_packages = {pkg.get(A_NAME, "") for pkg in queries.findall("package")}
    for pkg_name in OPENXR_QUERY_PACKAGES:
        if pkg_name not in existing_packages:
            pkg_el = ET.SubElement(queries, "package")
            pkg_el.set(A_NAME, pkg_name)
            changes["queries_added"] += 1

    app = root.find("application")
    if app is not None:
        if app.get(A_EXTRACT_NATIVE_LIBS) != "true":
            app.set(A_EXTRACT_NATIVE_LIBS, "true")
            changes["extract_native_libs_set"] = True

        for activity in app.findall("activity") + app.findall("activity-alias"):
            for intent_filter in activity.findall("intent-filter"):
                actions = {a.get(A_NAME, "") for a in intent_filter.findall("action")}
                categories = {c.get(A_NAME, "") for c in intent_filter.findall("category")}
                if (
                    "android.intent.action.MAIN" in actions
                    and "android.intent.category.LAUNCHER" not in categories
                    and (categories & VR_LAUNCHER_CATEGORIES)
                ):
                    cat_el = ET.SubElement(intent_filter, "category")
                    cat_el.set(A_NAME, "android.intent.category.LAUNCHER")
                    changes["launcher_categories_added"] += 1

    if hasattr(ET, "indent"):
        ET.indent(tree, space="    ")
    tree.write(manifest_path, encoding="utf-8", xml_declaration=True)
    return changes


def download_khronos_loader_aar(version: str, dest_aar: Path) -> Path:
    """Download the official Khronos OpenXR Loader AAR from Maven Central."""
    url = (
        f"https://repo1.maven.org/maven2/org/khronos/openxr/"
        f"openxr_loader_for_android/{version}/openxr_loader_for_android-{version}.aar"
    )
    print(f"[openxr] Baixando Khronos OpenXR Loader {version} de Maven Central...")
    dest_aar.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "quest-to-monado-patcher/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest_aar, "wb") as out:
        shutil.copyfileobj(resp, out)
    return dest_aar


def extract_loader_so_from_aar(aar_path: Path) -> Dict[str, bytes]:
    """Return a mapping of ABI -> libopenxr_loader.so bytes from a Khronos AAR."""
    found: Dict[str, bytes] = {}
    with zipfile.ZipFile(aar_path, "r") as zf:
        for name in zf.namelist():
            if not name.endswith("/libopenxr_loader.so"):
                continue
            for abi in ("arm64-v8a", "armeabi-v7a", "x86_64", "x86"):
                if f"/{abi}/" in name or f"/android.{abi}/" in name:
                    found[abi] = zf.read(name)
    return found


def swap_openxr_loader(unpacked_dir: Path, aar_path: Path) -> List[str]:
    """Replace or inject Khronos libopenxr_loader.so for each ABI present in `unpacked_dir/lib`."""
    loaders = extract_loader_so_from_aar(aar_path)
    if not loaders:
        raise RuntimeError(f"Nenhuma libopenxr_loader.so encontrada dentro de {aar_path}")

    lib_dir = unpacked_dir / "lib"
    swapped: List[str] = []
    if not lib_dir.exists():
        return swapped

    for abi_dir in sorted(lib_dir.iterdir()):
        if not abi_dir.is_dir():
            continue
        abi = abi_dir.name
        if abi in loaders:
            target = abi_dir / "libopenxr_loader.so"
            target.write_bytes(loaders[abi])
            swapped.append(abi)
    return swapped


def _find_android_tool(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") or ""
    if sdk:
        matches = sorted(glob.glob(os.path.join(sdk, "build-tools", "*", name)))
        if matches:
            return matches[-1]
    raise RuntimeError(f"Ferramenta Android nao encontrada no PATH/ANDROID_HOME: {name}")


def ensure_debug_keystore(keystore_path: Path) -> Path:
    if keystore_path.exists():
        return keystore_path
    keystore_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "keytool",
            "-genkeypair",
            "-v",
            "-keystore",
            str(keystore_path),
            "-storepass",
            "android",
            "-alias",
            "monado_patcher",
            "-keypass",
            "android",
            "-keyalg",
            "RSA",
            "-keysize",
            "2048",
            "-validity",
            "10000",
            "-dname",
            "CN=MonadoPhonePatcher,OU=VR,O=OpenXR,L=BR,S=SP,C=BR",
        ],
        check=True,
    )
    return keystore_path


def render_markdown_report(
    analysis: Dict[str, Any],
    manifest_changes: Optional[Dict[str, Any]],
    swapped_abis: List[str],
    unity_stats: Optional[Dict[str, Any]],
) -> str:
    lines = [
        "# Relatorio de Compatibilidade e Patch (Monado OpenXR para Celular)",
        "",
        f"- **APK analisado:** `{analysis['apk_name']}` ({analysis['apk_size_mb']} MB)",
        f"- **Motor detectado:** {analysis['engine']}",
        f"- **ABIs nativas:** {', '.join(analysis['abis']) or 'nenhuma'}",
        f"- **Loader OpenXR original:** `{analysis['openxr_loader_vendor']}` (presente: {analysis['has_openxr_loader']})",
        f"- **Unity OpenXR (`libUnityOpenXR.so`):** {analysis['has_unity_openxr']}",
        f"- **OVRPlugin (`libOVRPlugin.so`):** {analysis['has_ovr_plugin']}",
        f"- **Meta Platform SDK (`libovrplatformloader.so`):** {analysis['has_ovr_platform']}",
        f"- **VrApi legado (`libvrapi.so`):** {analysis['has_vrapi']}",
    ]
    if analysis["extensions_hint"]:
        lines.append(f"- **Extensoes encontradas em binarios:** {', '.join(analysis['extensions_hint'])}")

    lines.extend(["", "## Patch aplicado"])
    if manifest_changes:
        lines.append(
            f"- **Features de headset tornadas opcionais:** {', '.join(manifest_changes['features_made_optional']) or 'nenhuma'}"
        )
        lines.append(f"- **Queries OpenXR/Monado adicionadas:** {manifest_changes['queries_added']}")
        lines.append(
            f"- **Categoria LAUNCHER adicionada:** {manifest_changes['launcher_categories_added']}"
        )
        lines.append(
            f"- **extractNativeLibs=true:** {manifest_changes['extract_native_libs_set']}"
        )
    lines.append(
        f"- **Khronos OpenXR Loader injetado para ABIs:** {', '.join(swapped_abis) or 'nao aplicado'}"
    )

    if unity_stats:
        lines.extend(["", "## Otimizacao grafica Unity", "```json", json.dumps(unity_stats, indent=2), "```"])

    if analysis["warnings"]:
        lines.extend(["", "## Avisos tecnicos importantes"])
        for w in analysis["warnings"]:
            lines.append(f"- {w}")

    lines.extend(
        [
            "",
            "## Como rodar no celular Android (Monado + Giroscopio + Hand Tracking)",
            "1. Instale um runtime OpenXR para celular com giroscopio + hand tracking pela camera, como **PhoneXR** (`samrat1games/phonexr`) ou **HyperMagic** (`mt-VR/HyperXR`).",
            "2. Instale o **OpenXR Runtime Broker** (Khronos) se o runtime selecionado nao incluir broker proprio, e selecione o **Monado / PhoneXR Runtime** como runtime ativo.",
            "3. Instale o APK patcheado gerado neste workflow.",
            "4. Se o jogo usar arquivo `.obb`, copie o `.obb` para `/Android/obb/<nome_do_pacote>/` no celular.",
        ]
    )
    return "\n".join(lines) + "\n"


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Patcher de APK Quest/OpenXR para celular com Monado OpenXR.")
    parser.add_argument("--apk", required=True, help="Caminho do APK de entrada")
    parser.add_argument("--out-apk", default="", help="Caminho do APK patcheado e assinado de saida")
    parser.add_argument("--obb", default="", help="Caminho opcional do OBB de entrada")
    parser.add_argument("--out-obb", default="", help="Caminho opcional do OBB otimizado de saida")
    parser.add_argument("--report", default="", help="Caminho opcional para salvar o relatorio Markdown")
    parser.add_argument("--analyze-only", action="store_true", help="Apenas analisa o APK sem modificar")
    parser.add_argument("--no-manifest-patch", action="store_true", help="Nao alterar AndroidManifest.xml")
    parser.add_argument("--no-swap-loader", action="store_true", help="Nao trocar libopenxr_loader.so")
    parser.add_argument("--khronos-aar", default="", help="AAR local do Khronos OpenXR Loader (opcional)")
    parser.add_argument("--openxr-version", default="1.1.62", help="Versao Maven do openxr_loader_for_android")
    parser.add_argument(
        "--texture-preset",
        choices=("original", "medium", "low", "ultra_low"),
        default="low",
        help="Preset de reducao de qualidade Unity",
    )
    parser.add_argument(
        "--max-texture-size",
        type=int,
        default=0,
        help="Resolucao maxima de Texture2D (0 = apenas mipmap QualitySettings)",
    )
    args = parser.parse_args(argv)

    apk_path = Path(args.apk).resolve()
    if not apk_path.exists():
        raise SystemExit(f"APK nao encontrado: {apk_path}")

    analysis = analyze_apk(apk_path)
    print(json.dumps(analysis, indent=2, ensure_ascii=False))

    if args.analyze_only:
        if args.report:
            Path(args.report).write_text(
                render_markdown_report(analysis, None, [], None), encoding="utf-8"
            )
        return 0

    if not args.out_apk:
        raise SystemExit("--out-apk e obrigatorio quando --analyze-only nao esta ativo")

    out_apk = Path(args.out_apk).resolve()
    out_apk.parent.mkdir(parents=True, exist_ok=True)

    manifest_changes: Optional[Dict[str, Any]] = None
    swapped_abis: List[str] = []
    unity_stats: Optional[Dict[str, Any]] = None

    with tempfile.TemporaryDirectory(prefix="monado_patch_") as tmp:
        tmp_dir = Path(tmp)
        unpacked = tmp_dir / "unpacked"

        print("[patch] Desempacotando APK com apktool (-s para preservar DEX intacto)...")
        subprocess.run(
            ["apktool", "d", "-f", "-s", str(apk_path), "-o", str(unpacked)],
            check=True,
        )

        if not args.no_manifest_patch:
            manifest_path = unpacked / "AndroidManifest.xml"
            if manifest_path.exists():
                print("[patch] Aplicando ajustes no AndroidManifest.xml para celular + Monado...")
                manifest_changes = patch_manifest_xml(manifest_path)
                print(json.dumps(manifest_changes, indent=2))

        if not args.no_swap_loader:
            aar_path = Path(args.khronos_aar) if args.khronos_aar else tmp_dir / "openxr_loader.aar"
            if not aar_path.exists():
                download_khronos_loader_aar(args.openxr_version, aar_path)
            swapped_abis = swap_openxr_loader(unpacked, aar_path)
            print(f"[patch] Khronos libopenxr_loader.so aplicado para ABIs: {swapped_abis}")

        if args.texture_preset != "original" or args.max_texture_size > 0:
            stats_file = tmp_dir / "unity_stats.json"
            reduce_script = Path(__file__).with_name("reduce_unity_textures.py")
            cmd = [
                sys.executable,
                str(reduce_script),
                "--apk-unpacked-dir",
                str(unpacked),
                "--preset",
                args.texture_preset,
                "--max-texture-size",
                str(args.max_texture_size),
                "--stats-out",
                str(stats_file),
            ]
            if args.obb and args.out_obb:
                cmd.extend(["--obb-in", args.obb, "--obb-out", args.out_obb])
            subprocess.run(cmd, check=True)
            if stats_file.exists():
                unity_stats = json.loads(stats_file.read_text(encoding="utf-8"))
        elif args.obb and args.out_obb and Path(args.obb).exists():
            Path(args.out_obb).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(args.obb, args.out_obb)

        unsigned_apk = tmp_dir / "rebuilt-unsigned.apk"
        aligned_apk = tmp_dir / "rebuilt-aligned.apk"

        print("[patch] Recompilando APK com apktool...")
        subprocess.run(
            ["apktool", "b", str(unpacked), "-o", str(unsigned_apk)],
            check=True,
        )

        zipalign = _find_android_tool("zipalign")
        apksigner = _find_android_tool("apksigner")

        print("[patch] Alinhando APK (zipalign -p 4)...")
        subprocess.run(
            [zipalign, "-f", "-p", "4", str(unsigned_apk), str(aligned_apk)],
            check=True,
        )

        keystore = ensure_debug_keystore(tmp_dir / "debug.keystore")
        print("[patch] Assinando APK com apksigner (v1+v2+v3)...")
        subprocess.run(
            [
                apksigner,
                "sign",
                "--ks",
                str(keystore),
                "--ks-pass",
                "pass:android",
                "--ks-key-alias",
                "monado_patcher",
                "--key-pass",
                "pass:android",
                "--out",
                str(out_apk),
                str(aligned_apk),
            ],
            check=True,
        )

    if args.report:
        report_md = render_markdown_report(analysis, manifest_changes, swapped_abis, unity_stats)
        Path(args.report).write_text(report_md, encoding="utf-8")

    print(f"[patch] Concluido com sucesso: {out_apk}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
