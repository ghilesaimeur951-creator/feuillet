#!/usr/bin/env python3
"""Reference implementation of the classic OpenCV document-detection pipeline
(gray → blur → Canny → dilate → findContours → approxPolyDP → largest convex quad),
run on the synthetic fixtures to compare its corner accuracy with Feuillet's TypeScript detector.

Usage: python3 scripts/opencv_baseline.py  → prints one JSON object per fixture.
"""
import json
import os

import cv2
import numpy as np

DIR = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "cv")


def order(pts: np.ndarray) -> np.ndarray:
    c = pts.mean(axis=0)
    ang = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0])
    pts = pts[np.argsort(ang)]
    start = int(np.argmin(pts[:, 0] + pts[:, 1]))
    return np.roll(pts, -start, axis=0)


def detect(gray: np.ndarray):
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    h, w = gray.shape
    best = None
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:10]:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4 and cv2.isContourConvex(approx) and cv2.contourArea(approx) > 0.04 * w * h:
            best = order(approx.reshape(4, 2).astype(np.float64))
            break
    return best


def main() -> None:
    cases = json.load(open(os.path.join(DIR, "cases.json"), encoding="utf-8"))
    for c in cases:
        gray = cv2.imread(os.path.join(DIR, c["file"]), cv2.IMREAD_GRAYSCALE)
        q = detect(gray)
        err = None
        if q is not None and c["corners"]:
            gt = np.array(c["corners"], dtype=np.float64)
            err = float(np.max(np.linalg.norm(q - gt, axis=1)))
        print(json.dumps({"name": c["name"], "found": q is not None, "maxError": err}))


if __name__ == "__main__":
    main()
