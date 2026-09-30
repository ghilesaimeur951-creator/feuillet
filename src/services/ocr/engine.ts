import { parseTesseractTsv } from '../../core/ocr/analysis';
import type { OcrWord } from '../../core/ocr/analysis';

/** Minimal typing of the Tesseract WASM module (tesseract.js-core, Emscripten + embind). */
export interface TessApi {
  Init(dataPath: string | null, langs: string, oem: number): number;
  SetVariable(name: string, value: string): boolean;
  SetImageFile(exif: number, angle: number): number;
  Recognize(monitor: null): number;
  GetTSVText(): string;
  MeanTextConf(): number;
  Clear(): void;
  End(): void;
}

export interface TessModule {
  FS: {
    writeFile(path: string, data: Uint8Array | string): void;
    unlink(path: string): void;
    readdir(path: string): string[];
  };
  TessBaseAPI: new () => TessApi;
}

export type TesseractCoreFactory = (opts: Record<string, unknown>) => Promise<TessModule>;

export interface OcrOutput {
  text: string;
  words: OcrWord[];
  confidence: number;
}

const OEM_LSTM_ONLY = 1;
const PSM_AUTO = '3';

/**
 * Thin wrapper over the Tesseract C++ API compiled to WebAssembly. Used by the OCR worker and by
 * the unit tests (same code path).
 */
export class OcrEngine {
  private api: TessApi | null = null;
  private loadedLangs = new Set<string>();
  private initLangs = '';

  constructor(private readonly mod: TessModule) {}

  static async create(factory: TesseractCoreFactory, onProgress?: (p: number) => void): Promise<OcrEngine> {
    const mod = await factory({
      TesseractProgress(percent: number) {
        onProgress?.(Math.max(0, Math.min(1, (percent - 30) / 70)));
      },
    });
    return new OcrEngine(mod);
  }

  hasLanguage(lang: string): boolean {
    return this.loadedLangs.has(lang);
  }

  loadLanguage(lang: string, data: Uint8Array): void {
    if (!/^[a-z_]{3,8}$/.test(lang)) throw new Error(`Code de langue invalide : ${lang}`);
    this.mod.FS.writeFile(`./${lang}.traineddata`, data);
    this.loadedLangs.add(lang);
  }

  init(langs: readonly string[]): void {
    const key = langs.join('+');
    if (this.api && this.initLangs === key) return;
    for (const l of langs) if (!this.loadedLangs.has(l)) throw new Error(`Données de langue manquantes : ${l}`);
    this.api?.End();
    const api = new this.mod.TessBaseAPI();
    if (api.Init(null, key, OEM_LSTM_ONLY) === -1) throw new Error('Initialisation de Tesseract impossible (données de langue invalides)');
    api.SetVariable('tessedit_pageseg_mode', PSM_AUTO);
    api.SetVariable('user_defined_dpi', '300');
    api.SetVariable('preserve_interword_spaces', '1');
    this.api = api;
    this.initLangs = key;
  }

  /** Recognises an encoded image (PNG/JPEG/BMP bytes). */
  recognize(image: Uint8Array): OcrOutput {
    if (!this.api) throw new Error('Moteur OCR non initialisé');
    this.mod.FS.writeFile('/input', image);
    try {
      if (this.api.SetImageFile(1, 0) === 1) throw new Error('Image illisible pour l’OCR');
      this.api.Recognize(null);
      const parsed = parseTesseractTsv(this.api.GetTSVText());
      return { text: parsed.text, words: parsed.words, confidence: this.api.MeanTextConf() };
    } finally {
      try {
        this.mod.FS.unlink('/input');
      } catch {
        /* already removed */
      }
    }
  }

  dispose(): void {
    this.api?.End();
    this.api = null;
  }
}
