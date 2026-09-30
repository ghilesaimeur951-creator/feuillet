/** Reads the frame header of a JPEG file (dimensions and colour components). */
export interface JpegInfo {
  width: number;
  height: number;
  components: 1 | 3 | 4;
  /** True when an Adobe APP14 marker is present (CMYK JPEGs from Adobe are stored inverted). */
  adobe: boolean;
}

export function readJpegInfo(data: Uint8Array): JpegInfo {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('Données JPEG invalides (marqueur SOI absent)');
  let i = 2;
  let adobe = false;
  while (i + 4 < data.length) {
    if (data[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = data[i + 1] as number;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = ((data[i + 2] as number) << 8) | (data[i + 3] as number);
    if (marker === 0xee) adobe = true;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = ((data[i + 5] as number) << 8) | (data[i + 6] as number);
      const width = ((data[i + 7] as number) << 8) | (data[i + 8] as number);
      const comps = data[i + 9] as number;
      if (comps !== 1 && comps !== 3 && comps !== 4) throw new Error(`JPEG : ${comps} composantes non supportées`);
      return { width, height, components: comps, adobe };
    }
    i += 2 + len;
  }
  throw new Error('JPEG : en-tête de trame introuvable');
}
