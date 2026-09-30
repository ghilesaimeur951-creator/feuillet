/** Page geometry for PDF export. Units are PostScript points (1/72 inch). */

export type PageSizeId = 'A4' | 'Letter' | 'auto';
export type OrientationId = 'portrait' | 'landscape' | 'auto';

export const PAGE_SIZES: Record<Exclude<PageSizeId, 'auto'>, { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  Letter: { width: 612, height: 792 },
};

export interface PageLayout {
  pageWidth: number;
  pageHeight: number;
  /** Image placement (bottom-left origin). */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Computes the page box and the centred "contain" placement of an image.
 * `auto` size gives the page the image's aspect ratio (long side = A4 long side) plus margins.
 */
export function layoutPage(
  imageWidth: number,
  imageHeight: number,
  size: PageSizeId,
  orientation: OrientationId,
  margin: number,
): PageLayout {
  const landscapeImage = imageWidth > imageHeight;
  if (size === 'auto') {
    const long = 841.89 - 2 * margin;
    const scale = long / Math.max(imageWidth, imageHeight);
    const w = imageWidth * scale;
    const h = imageHeight * scale;
    return { pageWidth: w + 2 * margin, pageHeight: h + 2 * margin, x: margin, y: margin, width: w, height: h };
  }
  const base = PAGE_SIZES[size];
  const landscape = orientation === 'landscape' || (orientation === 'auto' && landscapeImage);
  const pageWidth = landscape ? base.height : base.width;
  const pageHeight = landscape ? base.width : base.height;
  const availW = Math.max(1, pageWidth - 2 * margin);
  const availH = Math.max(1, pageHeight - 2 * margin);
  const scale = Math.min(availW / imageWidth, availH / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    pageWidth,
    pageHeight,
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height,
  };
}

export interface QualityProfile {
  id: 'small' | 'standard' | 'high';
  label: string;
  /** Maximum pixel size of the long side of each page image. */
  maxSide: number;
  /** JPEG quality 0..1. */
  jpegQuality: number;
}

export const QUALITY_PROFILES: readonly QualityProfile[] = [
  { id: 'small', label: 'Petite taille', maxSide: 1400, jpegQuality: 0.55 },
  { id: 'standard', label: 'Standard', maxSide: 2200, jpegQuality: 0.75 },
  { id: 'high', label: 'Haute qualité', maxSide: 3508, jpegQuality: 0.9 },
];

/**
 * Rough estimate of an exported PDF size in bytes from the page pixel counts, based on typical
 * bits-per-pixel of document JPEGs at each quality (calibrated on scanned pages).
 */
export function estimatePdfSize(pages: ReadonlyArray<{ width: number; height: number; grayscale?: boolean }>, profile: QualityProfile): number {
  const bpp = 0.25 + profile.jpegQuality * profile.jpegQuality * 1.9;
  let total = 1200;
  for (const p of pages) {
    const s = Math.min(1, profile.maxSide / Math.max(p.width, p.height));
    const px = p.width * s * p.height * s;
    total += (px * bpp * (p.grayscale ? 0.6 : 1)) / 8 + 900;
  }
  return Math.round(total);
}
