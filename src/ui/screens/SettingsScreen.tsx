import { useEffect, useState } from 'preact/hooks';
import { FILTERS } from '../../core/imaging/filters';
import { QUALITY_PROFILES } from '../../core/pdf/layout';
import { confirmDialog, library, toast, useLibrary, useSettings } from '../../app/state';
import { APP_VERSION, OCR_LANGUAGES } from '../../services/config';
import { ocr } from '../../services/ocr/client';
import { settings } from '../../services/settings';
import type { Settings } from '../../services/settings';
import { Icon } from '../components/Icon';
import { Button, formatBytes, Segmented, Switch } from '../components/ui';

function Select<K extends keyof Settings>({
  k,
  label,
  hint,
  options,
}: {
  k: K;
  label: string;
  hint?: string;
  options: Array<{ value: string; label: string }>;
}) {
  const s = useSettings();
  return (
    <label class="settings-row">
      <span>
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
      <select class="select" value={String(s[k])} onChange={(e) => settings.set(k, (e.target as HTMLSelectElement).value as Settings[K])}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Preferences, storage, privacy information and keyboard shortcuts. */
export function SettingsScreen() {
  const s = useSettings();
  const lib = useLibrary();
  const [usage, setUsage] = useState<{ usage: number; quota: number; persisted: boolean } | null>(null);

  useEffect(() => {
    void (async () => {
      const est = await navigator.storage?.estimate?.().catch(() => null);
      const persisted = (await navigator.storage?.persisted?.().catch(() => false)) ?? false;
      if (est) setUsage({ usage: est.usage ?? 0, quota: est.quota ?? 0, persisted });
    })();
  }, [lib.documents().length]);

  const toggleLang = (code: string) => {
    const cur = s.ocrLanguages;
    const next = cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code];
    if (!next.length) return toast('Au moins une langue est nécessaire', 'info');
    settings.set('ocrLanguages', next);
    ocr.shutdown();
  };

  return (
    <div class="page settings-page">
      <header class="top-bar">
        <h1>Paramètres</h1>
      </header>

      <h2 class="section-title">Apparence</h2>
      <div class="settings-group">
        <div class="settings-row">
          <span>Thème</span>
          <Segmented
            label="Thème"
            value={s.theme}
            onChange={(v) => settings.set('theme', v)}
            options={[
              { value: 'system', label: 'Système' },
              { value: 'light', label: 'Clair', icon: 'sun' },
              { value: 'dark', label: 'Sombre', icon: 'moon' },
            ]}
          />
        </div>
      </div>

      <h2 class="section-title">Numérisation</h2>
      <div class="settings-group">
        <Switch
          checked={s.autoCapture}
          onChange={(v) => settings.set('autoCapture', v)}
          label="Capture automatique"
          hint="Déclenche la photo dès que le document est détecté, net et stable"
        />
        <Select k="defaultFilter" label="Filtre par défaut" options={FILTERS.map((f) => ({ value: f.id, label: f.label }))} />
        <Select
          k="scanResolution"
          label="Qualité de capture"
          hint="« Maximale » utilise le capteur photo complet quand le navigateur le permet"
          options={[
            { value: 'standard', label: 'Rapide (flux vidéo)' },
            { value: 'high', label: 'Haute (≈ 300 dpi A4)' },
            { value: 'max', label: 'Maximale' },
          ]}
        />
        <Switch
          checked={s.importAutoCrop}
          onChange={(v) => settings.set('importAutoCrop', v)}
          label="Recadrer les photos importées"
          hint="Détecte et redresse automatiquement le document sur les images importées"
        />
        <Switch checked={s.haptics} onChange={(v) => settings.set('haptics', v)} label="Vibrations" />
        <Switch checked={s.shutterSound} onChange={(v) => settings.set('shutterSound', v)} label="Son de l’obturateur" />
      </div>

      <h2 class="section-title">Reconnaissance de texte (OCR)</h2>
      <div class="settings-group">
        <Switch
          checked={s.autoOcr}
          onChange={(v) => settings.set('autoOcr', v)}
          label="OCR automatique après un scan"
          hint="Rend le contenu des scans recherchable"
        />
        <Switch
          checked={s.autoName}
          onChange={(v) => settings.set('autoName', v)}
          label="Nommer automatiquement"
          hint="« Facture — EDF — 2024-03-12 » au lieu de « Scan du … »"
        />
        <Switch
          checked={s.autoOrient}
          onChange={(v) => settings.set('autoOrient', v)}
          label="Redresser automatiquement l’orientation"
          hint="Page à l’envers ou tournée : l’OCR teste les rotations plausibles et garde la meilleure"
        />
        <div class="settings-row" style={{ display: 'block' }}>
          <span>Langues</span>
          <div class="chips" style={{ marginTop: '8px' }}>
            {OCR_LANGUAGES.map((l) => (
              <button
                type="button"
                key={l.code}
                class={`chip ${s.ocrLanguages.includes(l.code) ? 'is-active' : ''}`}
                aria-pressed={s.ocrLanguages.includes(l.code)}
                onClick={() => toggleLang(l.code)}
              >
                {l.label}
              </button>
            ))}
          </div>
          <small>Moins de langues = OCR plus rapide et plus précis. Modèles Tesseract installés localement.</small>
        </div>
      </div>

      <h2 class="section-title">Export PDF par défaut</h2>
      <div class="settings-group">
        <Select
          k="exportPageSize"
          label="Format de page"
          options={[
            { value: 'A4', label: 'A4' },
            { value: 'Letter', label: 'Letter' },
            { value: 'auto', label: 'Automatique' },
          ]}
        />
        <Select k="exportQuality" label="Qualité" options={QUALITY_PROFILES.map((p) => ({ value: p.id, label: p.label }))} />
        <Switch checked={s.searchablePdf} onChange={(v) => settings.set('searchablePdf', v)} label="PDF recherchable (couche texte OCR)" />
        <Switch checked={s.pageNumbers} onChange={(v) => settings.set('pageNumbers', v)} label="Numéroter les pages" />
      </div>

      <h2 class="section-title">Stockage</h2>
      <div class="settings-group">
        <div class="settings-row">
          <span>
            Espace utilisé
            <small>
              {lib.documents().length} document(s) · {lib.adapter.kind === 'indexeddb' ? 'IndexedDB (sur cet appareil)' : 'mémoire temporaire'}
              {usage
                ? ` · ${usage.persisted ? 'stockage persistant accordé' : 'stockage non persistant (le navigateur peut l’effacer en cas de manque de place)'}`
                : ''}
            </small>
          </span>
          <strong>{usage ? `${formatBytes(usage.usage)} / ${formatBytes(usage.quota)}` : '—'}</strong>
        </div>
        <div class="settings-row">
          <span>
            Nettoyer
            <small>Supprime les images orphelines (anciennes versions des pages)</small>
          </span>
          <Button
            size="sm"
            onClick={async () => {
              const n = await library().collectGarbage();
              toast(`${n} fichier(s) orphelin(s) supprimé(s)`, 'success');
            }}
          >
            Nettoyer
          </Button>
        </div>
        <div class="settings-row">
          <span>Historique des actions</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              if (await confirmDialog('Effacer l’historique ?', 'Les documents ne sont pas supprimés.', { confirmLabel: 'Effacer' }))
                await library().clearHistory();
            }}
          >
            Effacer
          </Button>
        </div>
      </div>

      <h2 class="section-title">Confidentialité</h2>
      <div class="settings-group">
        <p class="settings-row" style={{ display: 'block' }}>
          <Icon name="shield" size={18} /> <strong>Traitement 100 % local.</strong> La détection, les filtres, l’OCR et la création des PDF
          s’exécutent dans votre navigateur. Vos documents sont stockés uniquement sur cet appareil (IndexedDB) ; aucune donnée n’est envoyée à un
          serveur, et la politique de sécurité du contenu (CSP) de l’application interdit toute connexion vers un autre domaine. Aucun compte, aucun
          traceur.
        </p>
      </div>

      <h2 class="section-title">Raccourcis clavier</h2>
      <div class="settings-group">
        {[
          ['/', 'Rechercher'],
          ['n', 'Nouveau scan'],
          ['i', 'Importer des fichiers'],
          ['g', 'Retour à la bibliothèque'],
          ['Ctrl + Z / Ctrl + Y', 'Annuler / rétablir dans un document'],
          ['Alt + ← / →', 'Déplacer la page sélectionnée'],
          ['Suppr', 'Supprimer les pages sélectionnées'],
          ['Flèches (+ Maj)', 'Déplacer un coin du recadrage'],
        ].map(([k, v]) => (
          <div class="settings-row" key={k}>
            <span>{v}</span>
            <span class="kbd">{k}</span>
          </div>
        ))}
      </div>

      <div class="row" style={{ justifyContent: 'space-between', marginTop: '8px' }}>
        <span class="muted small">Feuillet v{APP_VERSION} — logiciel libre (MIT)</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            if (await confirmDialog('Réinitialiser les paramètres ?', 'Vos documents sont conservés.', { confirmLabel: 'Réinitialiser' }))
              settings.reset();
          }}
        >
          Réinitialiser les paramètres
        </Button>
      </div>
    </div>
  );
}
