#!/usr/bin/env python3
"""Generates realistic synthetic camera frames for the document-detection tests.

Each scene is rendered at high resolution (paper with text, textured table, lighting effects),
projected with a real perspective transform, then downscaled to the analysis resolution with
camera-like blur and sensor noise. Ground-truth corners are written to cases.json.

Usage: python3 scripts/gen_cv_fixtures.py  (requires numpy + opencv-python)
"""
import json
import os

import cv2
import numpy as np

OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "cv")
W, H = 1600, 1200
SCALE = 0.3  # analysis frames are 480x360
rng = np.random.default_rng(42)


def table(kind: str) -> np.ndarray:
    if kind == "dark":
        base = np.full((H, W, 3), (40, 55, 75), np.uint8)  # dark wood (BGR)
        grain = (rng.normal(0, 1, (H // 8, W)) * 12).astype(np.int16)
        grain = cv2.resize(grain.astype(np.float32), (W, H)).astype(np.int16)
        img = np.clip(base.astype(np.int16) + grain[..., None], 0, 255).astype(np.uint8)
    elif kind == "light":
        base = np.full((H, W, 3), (196, 202, 206), np.uint8)
        noise = cv2.GaussianBlur((rng.normal(0, 1, (H, W)) * 14).astype(np.float32), (0, 0), 6)
        img = np.clip(base.astype(np.float32) + noise[..., None], 0, 255).astype(np.uint8)
    else:  # cluttered
        img = np.full((H, W, 3), (70, 80, 90), np.uint8)
        for _ in range(40):
            c = tuple(int(v) for v in rng.integers(30, 140, 3))
            p = rng.integers(0, [W, H])
            cv2.circle(img, (int(p[0]), int(p[1])), int(rng.integers(10, 80)), c, -1)
    return img


def paper(w: int, h: int, tint=(250, 250, 248), lines=True) -> np.ndarray:
    p = np.full((h, w, 3), tint, np.uint8)
    if lines:
        y = int(h * 0.1)
        cv2.putText(p, "FACTURE N 2024-117", (int(w * 0.08), y), cv2.FONT_HERSHEY_SIMPLEX, w / 900, (30, 30, 30), 2)
        y += int(h * 0.06)
        while y < h * 0.9:
            x2 = int(w * (0.5 + 0.4 * rng.random()))
            cv2.line(p, (int(w * 0.08), y), (x2, y), (70, 70, 70), max(2, h // 300))
            y += int(h * 0.035)
        cv2.rectangle(p, (int(w * 0.55), int(h * 0.75)), (int(w * 0.92), int(h * 0.88)), (60, 60, 60), 2)
    return p


def place(bg: np.ndarray, doc: np.ndarray, corners, shadow=None) -> np.ndarray:
    h, w = doc.shape[:2]
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    M = cv2.getPerspectiveTransform(src, np.float32(corners))
    warped = cv2.warpPerspective(doc, M, (W, H), flags=cv2.INTER_LINEAR)
    mask = cv2.warpPerspective(np.full((h, w), 255, np.uint8), M, (W, H))
    # Soft contact shadow around the sheet.
    halo = cv2.GaussianBlur(mask, (0, 0), 12).astype(np.float32) / 255.0
    out = bg.astype(np.float32) * (1 - 0.35 * halo[..., None])
    m = (mask.astype(np.float32) / 255.0)[..., None]
    out = out * (1 - m) + warped.astype(np.float32) * m
    if shadow is not None:
        out *= shadow[..., None]
    return np.clip(out, 0, 255).astype(np.uint8)


def camera(img: np.ndarray, noise=3.0, gain=1.0) -> np.ndarray:
    small = cv2.resize(img, (int(W * SCALE), int(H * SCALE)), interpolation=cv2.INTER_AREA).astype(np.float32)
    small = cv2.GaussianBlur(small, (0, 0), 0.6) * gain
    small += rng.normal(0, noise, small.shape)
    return np.clip(small, 0, 255).astype(np.uint8)


def scale(corners):
    return [[round(x * SCALE, 2), round(y * SCALE, 2)] for x, y in corners]


cases = []


def save(name, frame, corners, expect="detect", note=""):
    cv2.imwrite(os.path.join(OUT, f"{name}.png"), cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
    cases.append({"name": name, "file": f"{name}.png", "corners": scale(corners) if corners else None, "expect": expect, "note": note})


def main():
    os.makedirs(OUT, exist_ok=True)
    a4 = paper(840, 1188)

    c = [[420, 150], [1170, 190], [1230, 1080], [360, 1050]]
    save("white-on-dark", camera(place(table("dark"), a4, c)), c, note="feuille blanche sur table sombre")

    c = [[430, 140], [1150, 170], [1190, 1060], [380, 1030]]
    save("white-on-light", camera(place(table("light"), paper(840, 1188, (246, 246, 244)), c)), c, note="feuille sur table claire (faible contraste)")

    ang = np.deg2rad(9)
    cx, cy, hw, hh = 800, 610, 330, 460
    c = [[cx + x * np.cos(ang) - y * np.sin(ang), cy + x * np.sin(ang) + y * np.cos(ang)] for x, y in [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]]
    save("tilted", camera(place(table("dark"), a4, c)), c, note="document incliné")

    c = [[560, 260], [1060, 250], [1420, 1110], [190, 1130]]
    save("strong-perspective", camera(place(table("dark"), a4, c)), c, note="forte perspective")

    shade = np.ones((H, W), np.float32)
    xs = np.linspace(0, 1, W)
    shade *= (0.45 + 0.55 * np.clip((xs - 0.35) * 3, 0, 1))[None, :]
    c = [[420, 150], [1170, 190], [1230, 1080], [360, 1050]]
    save("shadow", camera(place(table("dark"), a4, c, shadow=shade)), c, note="ombre sur la feuille")

    c = [[500, -120], [1250, -60], [1260, 900], [470, 880]]
    save("partial", camera(place(table("dark"), a4, c)), c, expect="partial-or-none", note="document partiellement hors cadre")

    c = [[500, 110], [1100, 110], [1100, 959], [500, 959]]
    save("a4-frontal", camera(place(table("dark"), a4, c)), c, note="feuille A4 de face")

    receipt = paper(300, 1050)
    c = [[690, 110], [930, 125], [915, 1110], [680, 1095]]
    save("receipt", camera(place(table("dark"), receipt, c)), c, note="reçu étroit")

    book = paper(800, 1100, (238, 232, 218))
    gut = np.linspace(0.75, 1, 120)
    book[:, :120] = (book[:, :120].astype(np.float32) * gut[None, :, None]).astype(np.uint8)
    c = [[470, 120], [1180, 150], [1200, 1100], [440, 1080]]
    save("book-page", camera(place(table("dark"), book, c)), c, note="page de livre (teinte crème, ombre de reliure)")

    c = [[420, 150], [1170, 190], [1230, 1080], [360, 1050]]
    save("low-light", camera(place(table("dark"), a4, c), noise=7.0, gain=0.38), c, note="faible luminosité")

    bg = table("cluttered")
    card = paper(300, 190, (40, 120, 200), lines=False)
    bg = place(bg, card, [[80, 900], [360, 880], [380, 1060], [95, 1080]])
    c = [[520, 120], [1230, 160], [1250, 1090], [480, 1060]]
    frame = place(bg, a4, c)
    frame = place(frame, paper(220, 140, (235, 235, 235), lines=False), [[1350, 200], [1560, 210], [1555, 340], [1345, 330]])
    save("multiple-rectangles", camera(frame), c, note="plusieurs rectangles visibles")

    save("no-document", camera(table("dark")), None, expect="none", note="aucun document")

    with open(os.path.join(OUT, "cases.json"), "w", encoding="utf-8") as f:
        json.dump(cases, f, indent=2, ensure_ascii=False)
    print(f"{len(cases)} fixtures written to {OUT}")


if __name__ == "__main__":
    main()
