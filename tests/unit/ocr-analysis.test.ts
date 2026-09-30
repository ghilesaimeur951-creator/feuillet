import { describe, expect, test } from 'bun:test';
import {
  classifyDocument,
  extractInvoiceData,
  findDate,
  parseAmount,
  parseTesseractTsv,
  suggestTags,
  suggestTitle,
} from '../../src/core/ocr/analysis';

const INVOICE = `EDF SA
22-30 avenue de Wagram 75008 Paris
FACTURE N° F-2024-0117
Date : 12/03/2024
Client : Jean Dupont
Consommation électricité mars
Total HT 70,17 €
TVA (20%) 14,03 €
Total TTC 84,20 €
Net à payer 84,20 €`;

const RECEIPT = `CARREFOUR MARKET
TICKET DE CAISSE
Pain 1,20
Lait 0,99
TOTAL 2,19 EUR
CB ****1234
MERCI DE VOTRE VISITE
02.05.2024 18:32`;

describe('analyse OCR', () => {
  test('parsing du TSV Tesseract', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '1\t1\t0\t0\t0\t0\t0\t0\t600\t800\t-1\t',
      '5\t1\t1\t1\t1\t1\t10\t20\t80\t30\t96.5\tFacture',
      '5\t1\t1\t1\t1\t2\t100\t20\t50\t30\t91.0\tEDF',
      '5\t1\t1\t1\t2\t1\t10\t60\t90\t30\t88.0\tMontant',
      '5\t1\t2\t1\t1\t1\t10\t200\t90\t30\t80.0\tFin',
    ].join('\n');
    const r = parseTesseractTsv(tsv);
    expect(r.words).toHaveLength(4);
    expect(r.text).toBe('Facture EDF\nMontant\n\nFin');
    expect(r.words[0]).toEqual({ text: 'Facture', confidence: 96.5, x: 10, y: 20, width: 80, height: 30, line: 0 });
    expect(r.confidence).toBeCloseTo(88.875, 3);
  });

  test('montants aux formats français, anglais et avec séparateurs', () => {
    expect(parseAmount('1 234,56')).toBe(1234.56);
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('84,20')).toBe(84.2);
    expect(parseAmount('12')).toBe(12);
    expect(parseAmount('abc')).toBeNull();
  });

  test('dates : jj/mm/aaaa, jj.mm.aaaa, ISO, texte', () => {
    expect(findDate('Date : 12/03/2024')).toBe('2024-03-12');
    expect(findDate('le 02.05.2024 à 18h')).toBe('2024-05-02');
    expect(findDate('émis le 2024-01-31')).toBe('2024-01-31');
    expect(findDate('Paris, le 1er février 2023')).toBe('2023-02-01');
    expect(findDate('rien')).toBeUndefined();
  });

  test('classification : facture, reçu, contrat, aucun', () => {
    expect(classifyDocument(INVOICE).kind).toBe('facture');
    expect(classifyDocument(RECEIPT).kind).toBe('recu');
    expect(classifyDocument('CONTRAT DE BAIL\nEntre les soussignés\nArticle 1 - Objet\nFait en deux exemplaires').kind).toBe('contrat');
    expect(classifyDocument('Bonjour le monde').kind).toBeNull();
  });

  test('extraction structurée d’une facture', () => {
    expect(extractInvoiceData(INVOICE)).toEqual({
      company: 'EDF SA',
      number: 'F-2024-0117',
      date: '2024-03-12',
      totalHT: 70.17,
      vat: 14.03,
      totalTTC: 84.2,
      currency: 'EUR',
    });
  });

  test('extraction d’un reçu', () => {
    const r = extractInvoiceData(RECEIPT);
    expect(r.totalTTC).toBe(2.19);
    expect(r.currency).toBe('EUR');
    expect(r.date).toBe('2024-05-02');
    expect(r.company).toBe('CARREFOUR MARKET');
  });

  test('titre et tags suggérés', () => {
    const inv = extractInvoiceData(INVOICE);
    expect(suggestTitle(INVOICE, 'facture', inv)).toBe('Facture — EDF SA — 2024-03-12');
    expect(suggestTags(INVOICE, 'facture', inv)).toEqual(['facture', 'edf', '2024']);
    expect(suggestTitle('Compte rendu de réunion\nPrésents : …', null)).toBe('Compte rendu de réunion');
  });
});
