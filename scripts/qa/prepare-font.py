"""Download one pinned OFL Noto font into CI's temporary fixture directory.

This never runs on package installation and never changes system fonts.
Source: https://github.com/notofonts/noto-cjk (SIL Open Font License 1.1).
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import urllib.request

URL = ("https://raw.githubusercontent.com/notofonts/noto-cjk/"
       "f8d157532fbfaeda587e826d4cd5b21a49186f7c/"
       "Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf")
SHA256 = "d68bafcb48a2707749396aa12bbbd833cb70401f3a9a689fd2902c7e0d295964"
SIZE = 17773132


def main():
    directory = Path(os.environ["DEEPMOYU_FONT_DIR"])
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "NotoSansSC-VF.ttf"
    if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == SHA256:
        print("Pinned Noto font fixture already verified")
        return
    with urllib.request.urlopen(URL, timeout=60) as response:
        data = response.read(SIZE + 1)
    if len(data) != SIZE or hashlib.sha256(data).hexdigest() != SHA256:
        raise ValueError("Pinned Noto font fixture failed size/SHA-256 verification")
    temporary = target.with_suffix(".download")
    temporary.write_bytes(data)
    temporary.replace(target)
    print("Pinned Noto font fixture verified; no system font installation")


if __name__ == "__main__":
    main()
