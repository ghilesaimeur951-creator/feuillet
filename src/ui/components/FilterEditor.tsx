import { useEffect, useRef, useState } from 'preact/hooks';
import type { Page } from '../../core/docs/model';
import { FILTERS, isNeutral, NEUTRAL_ADJUSTMENTS } from '../../core/imaging/filters';
import type { Adjustments, FilterId } from '../../core/imaging/filters';
import { library, toast } from '../../app/state';
import { processing } from '../../services/processing/client';
import { Button, Slider, Switch } from './ui';

const SLIDERS: Array<{ key: keyof Adjustments; label: string; min: number; max: number }> = [
  { key: 'brightness', label: 'Luminosité', min: -100, max: 100 },
  { key: 'contrast', label: 'Contraste', min: -100, max: 100 },
  { key: 'exposure', label: 'Exposition', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
  { key: 'sharpness', label: 'Netteté', min: 0, max: 100 },
  { key: 'denoise', label: 'Réduction du bruit / moiré', min: 0, max: 100 },
];

/** Live filter preview (computed off the main thread on a downscaled copy) + manual adjustments. */
export function FilterEditor({ page, onSave }: { page: Page; onSave: (filter: FilterId, adj: Adjustments, allPages: boolean) => Promise<void> }) {
  const [filter, setFilter] = useState<FilterId>(page.filter);
  const [adj, setAdj] = useState<Adjustments>(page.adjustments ?? NEUTRAL_ADJUSTMENTS);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [all, setAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const original = await library().getBlob(page.originalBlobId);
        if (!original || my !== seq.current) return;
        const blob = await processing.preview({
          original,
          quad: page.quad,
          rotation: page.rotation,
          filter,
          adjustments: adj,
          maxSide: 1100,
          quality: 0.85,
          cacheKey: page.originalBlobId,
        });
        if (my !== seq.current) return;
        const url = URL.createObjectURL(blob);
        setPreview((old) => {
          if (old) URL.revokeObjectURL(old);
          return url;
        });
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
      } finally {
        if (my === seq.current) setLoading(false);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [filter, adj]);

  useEffect(
    () => () => {
      setPreview((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
    },
    [],
  );

  return (
    <div class="editor-split">
      <div class="editor-stage">
        {preview ? <img src={preview} alt="Aperçu du filtre" class={`preview-img ${loading ? 'is-loading' : ''}`} /> : <div class="spinner" />}
      </div>
      <div class="editor-panel">
        <div class="filter-chips" role="radiogroup" aria-label="Préréglage">
          {FILTERS.map((f) => (
            <button
              type="button"
              role="radio"
              aria-checked={f.id === filter}
              key={f.id}
              class={`filter-chip ${f.id === filter ? 'is-active' : ''}`}
              onClick={() => setFilter(f.id)}
              title={f.description}
            >
              <span class={`filter-swatch swatch-${f.id}`} aria-hidden="true" />
              {f.label}
            </button>
          ))}
        </div>
        <details class="adjustments" open={!isNeutral(adj)}>
          <summary>Réglages manuels</summary>
          {SLIDERS.map((s) => (
            <Slider key={s.key} label={s.label} value={adj[s.key]} min={s.min} max={s.max} onInput={(v) => setAdj({ ...adj, [s.key]: v })} />
          ))}
          <Button variant="ghost" size="sm" icon="reset" onClick={() => setAdj(NEUTRAL_ADJUSTMENTS)} disabled={isNeutral(adj)}>
            Réinitialiser les réglages
          </Button>
        </details>
        <Switch checked={all} onChange={setAll} label="Appliquer à toutes les pages" />
        <Button
          variant="primary"
          icon="check"
          size="lg"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(filter, adj, all);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </Button>
      </div>
    </div>
  );
}
