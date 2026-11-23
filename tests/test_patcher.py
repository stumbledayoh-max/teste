import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import download_source  # noqa: E402
import patch_apk_for_monado as patcher  # noqa: E402
import reduce_unity_textures as reducer  # noqa: E402


SAMPLE_QUEST_MANIFEST = """<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.questgame">
    <uses-feature android:name="android.hardware.vr.headtracking" android:required="true" android:version="1" />
    <uses-feature android:name="oculus.software.handtracking" android:required="true" />
    <uses-feature android:name="com.oculus.feature.PASSTHROUGH" android:required="true" />
    <uses-feature android:name="android.hardware.opengles.aep" android:required="true" />

    <application android:label="Quest Game" android:extractNativeLibs="false">
        <activity android:name="com.unity3d.player.UnityPlayerActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="com.oculus.intent.category.VR" />
            </intent-filter>
        </activity>
    </application>
</manifest>
"""


class TestDownloader(unittest.TestCase):
    def test_parse_gofile_folder_id(self):
        self.assertEqual(
            download_source.parse_gofile_folder_id("https://gofile.io/d/HDTJBi"),
            "HDTJBi",
        )
        self.assertEqual(
            download_source.parse_gofile_folder_id("https://www.gofile.io/d/abc123_/"),
            "abc123_",
        )
        self.assertIsNone(
            download_source.parse_gofile_folder_id("https://example.com/game.apk")
        )

    def test_sanitize_filename(self):
        self.assertEqual(
            download_source.sanitize_filename("com.Game.Test (1).apk", "input.apk"),
            "com.Game.Test_1_.apk",
        )


class TestApkPatcher(unittest.TestCase):
    def test_analyze_quest_unity_apk(self):
        with tempfile.TemporaryDirectory() as tmp:
            apk_path = Path(tmp) / "sample_quest.apk"
            with zipfile.ZipFile(apk_path, "w") as zf:
                zf.writestr("lib/arm64-v8a/libil2cpp.so", b"\x7fELF")
                zf.writestr("lib/arm64-v8a/libopenxr_loader.so", b"Meta OculusOpenXR loader")
                zf.writestr("lib/arm64-v8a/libUnityOpenXR.so", b"\x7fELF")
                zf.writestr("lib/arm64-v8a/libOVRPlugin.so", b"XR_EXT_hand_tracking XR_FB_passthrough")
                zf.writestr("lib/arm64-v8a/libovrplatformloader.so", b"\x7fELF")
                zf.writestr("assets/bin/Data/globalgamemanagers", b"unity")

            info = patcher.analyze_apk(apk_path)
            self.assertEqual(info["engine"], "Unity (IL2CPP)")
            self.assertEqual(info["abis"], ["arm64-v8a"])
            self.assertEqual(info["openxr_loader_vendor"], "meta_proprietary")
            self.assertTrue(info["has_unity_openxr"])
            self.assertTrue(info["has_ovr_plugin"])
            self.assertTrue(info["has_ovr_platform"])
            self.assertIn("XR_EXT_hand_tracking", info["extensions_hint"])
            self.assertGreaterEqual(len(info["warnings"]), 2)

            report = patcher.render_markdown_report(info, None, ["arm64-v8a"], None)
            self.assertIn("Monado OpenXR", report)
            self.assertIn("arm64-v8a", report)

    def test_patch_manifest_xml_and_idempotency(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "AndroidManifest.xml"
            manifest.write_text(SAMPLE_QUEST_MANIFEST, encoding="utf-8")

            changes = patcher.patch_manifest_xml(manifest)
            self.assertCountEqual(
                changes["features_made_optional"],
                [
                    "android.hardware.vr.headtracking",
                    "oculus.software.handtracking",
                    "com.oculus.feature.PASSTHROUGH",
                ],
            )
            self.assertEqual(changes["launcher_categories_added"], 1)
            self.assertTrue(changes["extract_native_libs_set"])
            self.assertGreaterEqual(changes["queries_added"], 7)

            # Verify resulting XML structure
            tree = ET.parse(manifest)
            root = tree.getroot()
            features = {
                el.get(patcher.A_NAME): el.get(patcher.A_REQUIRED)
                for el in root.findall("uses-feature")
            }
            self.assertEqual(features["android.hardware.vr.headtracking"], "false")
            self.assertEqual(features["oculus.software.handtracking"], "false")
            self.assertEqual(features["android.hardware.opengles.aep"], "true")
            self.assertEqual(features["android.hardware.sensor.gyroscope"], "false")
            self.assertEqual(features["android.hardware.camera"], "false")

            queries = root.find("queries")
            self.assertIsNotNone(queries)
            actions = {
                a.get(patcher.A_NAME)
                for i in queries.findall("intent")
                for a in i.findall("action")
            }
            self.assertIn("org.khronos.openxr.OpenXRRuntimeService", actions)
            providers = {p.get(patcher.A_AUTHORITIES) for p in queries.findall("provider")}
            self.assertIn("org.khronos.openxr.runtime_broker", providers)
            self.assertIn("org.khronos.openxr.system_runtime_broker", providers)

            app = root.find("application")
            self.assertEqual(app.get(patcher.A_EXTRACT_NATIVE_LIBS), "true")
            cats = {
                c.get(patcher.A_NAME)
                for act in app.findall("activity")
                for f in act.findall("intent-filter")
                for c in f.findall("category")
            }
            self.assertIn("android.intent.category.LAUNCHER", cats)

            # Second run must be idempotent
            changes2 = patcher.patch_manifest_xml(manifest)
            self.assertEqual(changes2["features_made_optional"], [])
            self.assertEqual(changes2["queries_added"], 0)
            self.assertEqual(changes2["launcher_categories_added"], 0)
            self.assertFalse(changes2["extract_native_libs_set"])

    def test_swap_openxr_loader_from_aar(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            aar = tmp_dir / "openxr_loader.aar"
            khronos_bytes = b"\x7fELF_KHRONOS_ORG_KHRONOS_OPENXR"
            with zipfile.ZipFile(aar, "w") as zf:
                zf.writestr(
                    "prefab/modules/openxr_loader/libs/android.arm64-v8a/libopenxr_loader.so",
                    khronos_bytes,
                )

            unpacked = tmp_dir / "unpacked"
            (unpacked / "lib" / "arm64-v8a").mkdir(parents=True)
            (unpacked / "lib" / "arm64-v8a" / "libopenxr_loader.so").write_bytes(b"META_OLD")

            swapped = patcher.swap_openxr_loader(unpacked, aar)
            self.assertEqual(swapped, ["arm64-v8a"])
            self.assertEqual(
                (unpacked / "lib" / "arm64-v8a" / "libopenxr_loader.so").read_bytes(),
                khronos_bytes,
            )


class TestUnityTextureReducer(unittest.TestCase):
    def test_compute_target_dimensions(self):
        self.assertIsNone(reducer.compute_target_dimensions(512, 512, 512))
        self.assertIsNone(reducer.compute_target_dimensions(2048, 2048, 0))
        self.assertEqual(reducer.compute_target_dimensions(2048, 1024, 512), (512, 256))
        self.assertEqual(reducer.compute_target_dimensions(1000, 500, 256), (256, 128))

    def test_apply_quality_preset_to_tree(self):
        tree = {
            "m_QualitySettings": [
                {
                    "name": "QuestDefault",
                    "globalTextureMipmapLimit": 0,
                    "masterTextureLimit": 0,
                    "antiAliasing": 4,
                    "anisotropicTextures": 2,
                    "shadows": 2,
                    "shadowResolution": 2,
                    "pixelLightCount": 4,
                    "softParticles": True,
                    "realtimeReflectionProbes": True,
                }
            ]
        }
        modified = reducer.apply_quality_preset_to_tree(tree, "low")
        self.assertEqual(modified, 1)
        lvl = tree["m_QualitySettings"][0]
        self.assertEqual(lvl["globalTextureMipmapLimit"], 2)
        self.assertEqual(lvl["masterTextureLimit"], 2)
        self.assertEqual(lvl["antiAliasing"], 0)
        self.assertEqual(lvl["shadows"], 0)
        self.assertFalse(lvl["softParticles"])
        self.assertFalse(lvl["realtimeReflectionProbes"])


if __name__ == "__main__":
    unittest.main()
