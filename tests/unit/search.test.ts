import { describe, expect, test } from 'bun:test';
import { makeSnippet, parseQuery, SearchIndex } from '../../src/core/search/index';
import type { SearchableDocument } from '../../src/core/search/index';
import { editDistance, normalize } from '../../src/core/search/text';

const now = Date.now();
const base: Omit<SearchableDocument, 'id' | 'title'> = {
  folderPath: '',
  tags: [],
  notes: '',
  content: '',
  type: 'scan',
  createdAt: now,
  updatedAt: now,
};

function index(): SearchIndex {
  const idx = new SearchIndex();
  idx.upsert({
    ...base,
    id: 'scan27',
    title: 'Scan 27',
    content: 'ELECTRICITE DE FRANCE\nFacture EDF n° 1234\nMontant TTC : 84,20 €\nÉchéance le 15/04/2024',
    type: 'scan facture',
  });
  idx.upsert({ ...base, id: 'bail', title: 'Contrat de location', folderPath: 'Logement', tags: ['bail', 'appartement'], content: 'Entre les soussignés…' });
  idx.upsert({ ...base, id: 'note', title: 'Liste de courses', notes: 'penser à la facture du plombier', content: 'lait, œufs, pain' });
  idx.upsert({ ...base, id: 'old', title: 'Relevé 2021', content: 'Relevé de compte', createdAt: new Date('2021-06-02').getTime(), updatedAt: new Date('2021-06-02').getTime() });
  return idx;
}

describe('normalisation', () => {
  test('accents, casse, ligatures, ponctuation', () => {
    expect(normalize('Électricité  — ŒUVRE, l’été !')).toBe('electricite oeuvre l ete');
    expect(editDistance('facture', 'factura')).toBe(1);
    expect(editDistance('facture', 'contrat', 2)).toBe(3);
  });

  test('requête : termes et phrases entre guillemets', () => {
    expect(parseQuery('facture "montant ttc" EDF')).toEqual({ terms: ['facture', 'edf'], phrases: ['montant ttc'] });
  });
});

describe('moteur de recherche', () => {
  test('« facture EDF » retrouve « Scan 27 » grâce à son contenu OCR', () => {
    const hits = index().search('facture EDF');
    expect(hits[0]?.id).toBe('scan27');
    expect(hits[0]?.fields).toContain('content');
    expect(hits[0]?.snippet).toContain('Facture EDF');
  });

  test('insensible aux accents et à la casse', () => {
    expect(index().search('electricite')[0]?.id).toBe('scan27');
    expect(index().search('ÉCHÉANCE')[0]?.id).toBe('scan27');
  });

  test('recherche sur tags, dossier, notes, titre et type', () => {
    const idx = index();
    expect(idx.search('appartement').map((h) => h.id)).toEqual(['bail']);
    expect(idx.search('logement').map((h) => h.id)).toEqual(['bail']);
    expect(idx.search('plombier').map((h) => h.id)).toEqual(['note']);
    expect(idx.search('location')[0]?.id).toBe('bail');
    expect(idx.search('facture').map((h) => h.id).sort()).toEqual(['note', 'scan27']);
  });

  test('recherche par date (année, mois)', () => {
    const idx = index();
    expect(idx.search('2021').map((h) => h.id)).toContain('old');
    expect(idx.search('juin 2021').map((h) => h.id)).toEqual(['old']);
  });

  test('préfixe (saisie en cours) et faute de frappe/OCR', () => {
    const idx = index();
    expect(idx.search('contr')[0]?.id).toBe('bail');
    expect(idx.search('factrue').length).toBe(0);
    expect(idx.search('electricte')[0]?.id).toBe('scan27');
  });

  test('tous les termes sont requis (ET logique) et phrases exactes', () => {
    const idx = index();
    expect(idx.search('facture contrat')).toHaveLength(0);
    expect(idx.search('"montant ttc"').map((h) => h.id)).toEqual(['scan27']);
    expect(idx.search('"ttc montant"')).toHaveLength(0);
  });

  test('filtres de type et de période, suppression de l’index', () => {
    const idx = index();
    expect(idx.search('', { type: 'facture' }).map((h) => h.id)).toEqual(['scan27']);
    expect(idx.search('releve', { from: new Date('2022-01-01').getTime() })).toHaveLength(0);
    idx.remove('scan27');
    expect(idx.search('EDF')).toHaveLength(0);
  });

  test('extrait avec surlignage', () => {
    const { snippet, highlights } = makeSnippet('Bonjour, voici la facture EDF du mois.', ['facture', 'edf']);
    expect(highlights.length).toBe(2);
    const [s, e] = highlights[0] as [number, number];
    expect(snippet.slice(s, e).toLowerCase()).toBe('facture');
  });
});
