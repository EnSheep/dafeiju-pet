"""下载 ffmpeg essentials 到 dsh-pet/.tools/ffmpeg-9.0.1-essentials_build/。

用 Python 的 OpenSSL 走 HTTPS（PowerShell/curl 的 schannel 在沙箱里拿不到凭证）。
"""
from __future__ import annotations

import io
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
ROOT = Path(r"C:\Users\lianzhi\Documents\deepseek-harness\default-workspace\dsh-pet")
DEST = ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build"
CACHE = ROOT / ".tools" / "_dl"


def fetch() -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    zip_path = CACHE / "ffmpeg-release-essentials.zip"
    if zip_path.exists() and zip_path.stat().st_size > 20_000_000:
        print(f"cached: {zip_path} ({zip_path.stat().st_size/1e6:.1f} MB)")
        return zip_path
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=60) as r, open(zip_path, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total:
                pct = done * 100 / total
                print(f"\r{done/1e6:7.1f}/{total/1e6:.1f} MB  {pct:5.1f}%  {done/1e6/(time.time()-t0):.1f} MB/s", end="", flush=True)
    print()
    return zip_path


def extract(zip_path: Path) -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        wanted = [n for n in names if n.split("/")[-1] in ("ffmpeg.exe", "ffprobe.exe", "ffplay.exe")]
        if not wanted:
            raise SystemExit(f"no binaries in zip; first entries: {names[:5]}")
        for n in wanted:
            target = DEST / "bin" / n.split("/")[-1]
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(n) as src, open(target, "wb") as out:
                while True:
                    b = src.read(1 << 20)
                    if not b:
                        break
                    out.write(b)
            print(f"extracted {target} ({target.stat().st_size/1e6:.1f} MB)")


def main() -> int:
    zp = fetch()
    extract(zp)
    exe = DEST / "bin" / "ffmpeg.exe"
    print("OK", exe, exe.exists())
    return 0


if __name__ == "__main__":
    sys.exit(main())
