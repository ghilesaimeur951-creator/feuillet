#!/usr/bin/env python3
"""Generates the fake camera stream used by the end-to-end tests (Chromium --use-file-for-fake-video-capture).

A sheet of paper with real text is placed in perspective on a dark table and slightly shaken like a
hand-held phone. Output: tests/fixtures/e2e/document.mjpeg (1280x720).
Requires numpy, opencv-python, pillow and ffmpeg.
"""
import os
import shutil
import subprocess
import tempfile

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "tests", "fixtures", "e2e", "document.mjpeg")
W, H = 1280, 720
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def paper() -> np.ndarray:
    pw, ph = 840, 1188
    img = Image.new("RGB", (pw, ph), (250, 249, 245))
    d = ImageDraw.Draw(img)
    big = ImageFont.truetype(BOLD, 64)
    mid = ImageFont.truetype(FONT, 44)
    d.text((70, 80), "FACTURE EDF", font=big, fill=(20, 20, 20))
    lines = ["Electricite de France", "Numero client 4471", "Date 12/03/2024", "Total HT 70,17 EUR", "TVA 14,03 EUR", "Total TTC 84,20 EUR"]
    y = 220
    for l in lines:
        d.text((70, y), l, font=mid, fill=(30, 30, 30))
        y += 110
    d.rectangle((60, 1000, 780, 1100), outline=(60, 60, 60), width=4)
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def main() -> None:
    rng = np.random.default_rng(3)
    doc = paper()
    ph, pw = doc.shape[:2]
    table = np.full((H, W, 3), (38, 50, 66), np.uint8)
    noise = cv2.GaussianBlur((rng.normal(0, 1, (H, W)) * 10).astype(np.float32), (0, 0), 3)
    table = np.clip(table.astype(np.float32) + noise[..., None], 0, 255).astype(np.uint8)
    base = np.float32([[470, 70], [830, 90], [860, 650], [430, 630]])
    tmp = tempfile.mkdtemp()
    try:
        for i in range(60):
            jitter = rng.normal(0, 0.6, (4, 2)).astype(np.float32)
            dst = base + jitter
            M = cv2.getPerspectiveTransform(np.float32([[0, 0], [pw, 0], [pw, ph], [0, ph]]), dst)
            warped = cv2.warpPerspective(doc, M, (W, H))
            mask = cv2.warpPerspective(np.full((ph, pw), 255, np.uint8), M, (W, H))
            m = (mask.astype(np.float32) / 255)[..., None]
            frame = (table * (1 - m) + warped * m).astype(np.uint8)
            frame = cv2.GaussianBlur(frame, (0, 0), 0.7)
            cv2.imwrite(os.path.join(tmp, f"f{i:03d}.png"), frame)
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "15", "-i", os.path.join(tmp, "f%03d.png"), "-c:v", "mjpeg", "-q:v", "4", "-f", "mjpeg", OUT], check=True)
    finally:
        shutil.rmtree(tmp)
    print(f"written {OUT} ({os.path.getsize(OUT) // 1024} KiB)")


if __name__ == "__main__":
    main()
