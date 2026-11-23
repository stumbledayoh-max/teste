#!/usr/bin/env python3
"""Download user-provided APK/OBB files for the GitHub Actions patcher pipeline.

Supports:
- Direct HTTP/HTTPS download URLs (GitHub Releases, file servers, etc.)
- Gofile.io folder links (https://gofile.io/d/<content_id>) automatically locating
  .apk and .obb entries when run in an environment with internet access.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional, Tuple

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
GOFILE_FOLDER_RE = re.compile(r"^https?://(?:www\.)?gofile\.io/d/([A-Za-z0-9_-]+)/?$")


def parse_gofile_folder_id(url: str) -> Optional[str]:
    """Return the Gofile content ID if `url` is a gofile.io/d/<id> link."""
    match = GOFILE_FOLDER_RE.match(url.strip())
    return match.group(1) if match else None


def _http_json(url: str, method: str = "GET", headers: Optional[Dict[str, str]] = None) -> dict:
    req_headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        req_headers.update(headers)
    data = b"{}" if method == "POST" else None
    if method == "POST":
        req_headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _fetch_gofile_website_token() -> str:
    """Fetch Gofile's current public web token (wt) from global.js, with fallback."""
    fallback = "4fd6sg89d7s6"
    try:
        req = urllib.request.Request(
            "https://gofile.io/dist/js/config.js",
            headers={"User-Agent": USER_AGENT},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            js = resp.read().decode("utf-8", errors="ignore")
        match = re.search(r'wt\s*[:=]\s*["\']([A-Za-z0-9]+)["\']', js)
        if match:
            return match.group(1)
    except Exception:
        pass
    return fallback


def resolve_gofile_folder(content_id: str) -> Tuple[str, List[Dict[str, str]]]:
    """Create a Gofile guest account and list downloadable files in a folder."""
    acct = _http_json("https://api.gofile.io/accounts", method="POST")
    token = acct.get("data", {}).get("token")
    if not token:
        raise RuntimeError(f"Nao foi possivel obter token guest da API Gofile: {acct}")

    wt = _fetch_gofile_website_token()
    url = f"https://api.gofile.io/contents/{urllib.parse.quote(content_id)}?wt={urllib.parse.quote(wt)}"
    payload = _http_json(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "X-Website-Token": wt,
        },
    )
    if payload.get("status") != "ok":
        raise RuntimeError(f"Gofile retornou erro ao listar pasta {content_id}: {payload}")

    children = payload.get("data", {}).get("children", {})
    files: List[Dict[str, str]] = []
    if isinstance(children, dict):
        iterable = children.values()
    elif isinstance(children, list):
        iterable = children
    else:
        iterable = []

    for entry in iterable:
        if entry.get("type") == "file" and entry.get("link"):
            files.append(
                {
                    "name": entry.get("name", "file.bin"),
                    "link": entry["link"],
                    "size": str(entry.get("size", "")),
                }
            )
    return token, files


def download_file(url: str, destination: Path, cookie: Optional[str] = None) -> Path:
    """Download a file using curl (robust retries/redirects) with urllib fallback."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "curl",
        "-fL",
        "--retry",
        "3",
        "--retry-delay",
        "5",
        "-A",
        USER_AGENT,
        "-o",
        str(destination),
    ]
    if cookie:
        cmd.extend(["-H", f"Cookie: {cookie}"])
    cmd.append(url)

    print(f"[download] Baixando para {destination.name}...")
    result = subprocess.run(cmd, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"Falha ao baixar {url} (curl exit code {result.returncode})")
    if not destination.exists() or destination.stat().st_size == 0:
        raise RuntimeError(f"Arquivo baixado vazio: {destination}")
    size_mb = destination.stat().st_size / (1024 * 1024)
    print(f"[download] OK: {destination.name} ({size_mb:.1f} MB)")
    return destination


def sanitize_filename(name: str, fallback: str) -> str:
    base = os.path.basename(name.strip())
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", base)
    return cleaned or fallback


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Baixa APK e OBB opcionais para o patcher.")
    parser.add_argument("--apk-url", required=True, help="URL direta do APK ou link gofile.io/d/<id>")
    parser.add_argument("--obb-url", default="", help="URL direta opcional do OBB")
    parser.add_argument("--out-dir", required=True, help="Diretorio de saida")
    parser.add_argument("--skip-obb", action="store_true", help="Nao baixar OBB mesmo se presente na pasta")
    args = parser.parse_args(argv)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    apk_path: Optional[Path] = None
    obb_path: Optional[Path] = None

    folder_id = parse_gofile_folder_id(args.apk_url)
    if folder_id:
        print(f"[download] Detectada pasta Gofile: {folder_id}")
        token, files = resolve_gofile_folder(folder_id)
        cookie = f"accountToken={token}"
        for f in files:
            lower = f["name"].lower()
            if lower.endswith(".apk") and apk_path is None:
                apk_path = download_file(
                    f["link"],
                    out_dir / sanitize_filename(f["name"], "input.apk"),
                    cookie=cookie,
                )
            elif lower.endswith(".obb") and obb_path is None and not args.skip_obb:
                obb_path = download_file(
                    f["link"],
                    out_dir / sanitize_filename(f["name"], "main.obb"),
                    cookie=cookie,
                )
        if apk_path is None:
            raise RuntimeError("Nenhum arquivo .apk encontrado na pasta Gofile informada.")
    else:
        parsed_name = os.path.basename(urllib.parse.urlparse(args.apk_url).path)
        apk_name = sanitize_filename(parsed_name if parsed_name.lower().endswith(".apk") else "input.apk", "input.apk")
        apk_path = download_file(args.apk_url, out_dir / apk_name)

    if args.obb_url.strip() and not args.skip_obb and obb_path is None:
        obb_folder_id = parse_gofile_folder_id(args.obb_url)
        if obb_folder_id:
            token, files = resolve_gofile_folder(obb_folder_id)
            cookie = f"accountToken={token}"
            for f in files:
                if f["name"].lower().endswith(".obb"):
                    obb_path = download_file(
                        f["link"],
                        out_dir / sanitize_filename(f["name"], "main.obb"),
                        cookie=cookie,
                    )
                    break
        else:
            parsed_name = os.path.basename(urllib.parse.urlparse(args.obb_url).path)
            obb_name = sanitize_filename(parsed_name if parsed_name.lower().endswith(".obb") else "main.obb", "main.obb")
            obb_path = download_file(args.obb_url, out_dir / obb_name)

    manifest_out = {
        "apk": str(apk_path) if apk_path else "",
        "obb": str(obb_path) if obb_path else "",
    }
    (out_dir / "downloaded.json").write_text(json.dumps(manifest_out, indent=2), encoding="utf-8")
    print(json.dumps(manifest_out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
