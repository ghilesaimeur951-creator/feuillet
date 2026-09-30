import { useEffect, useRef, useState } from 'preact/hooks';
import { closeDialog, dismissToast, useBusy, useDialog, useToasts } from '../../app/state';
import type { DialogRequest } from '../../app/state';
import { Icon } from './Icon';
import { Button, Progress, Sheet } from './ui';

/** Renders the global toasts (aria-live), dialogs and the busy overlay. */
export function Overlays() {
  return (
    <>
      <ToastHost />
      <DialogHost />
      <BusyOverlay />
    </>
  );
}

function ToastHost() {
  const toasts = useToasts();
  return (
    <div class="toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class={`toast toast-${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'info'} size={18} />
          <span class="toast-msg">{t.message}</span>
          {t.action ? (
            <button
              type="button"
              class="toast-action"
              onClick={() => {
                t.action?.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button type="button" class="toast-close" aria-label="Fermer la notification" onClick={() => dismissToast(t.id)}>
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

function DialogHost() {
  const d = useDialog();
  if (!d) return null;
  return <DialogView key={d.title} d={d} />;
}

function DialogView({ d }: { d: DialogRequest }) {
  const [value, setValue] = useState(d.kind === 'prompt' ? (d.value ?? '') : '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (d.kind === 'prompt') setTimeout(() => input.current?.select(), 30);
  }, [d]);
  const cancel = () => {
    closeDialog();
    if (d.kind === 'confirm') d.resolve(false);
    else d.resolve(null);
  };
  return (
    <Sheet open onClose={cancel} title={d.title}>
      {d.message ? <p class="dialog-message">{d.message}</p> : null}
      {d.kind === 'prompt' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            closeDialog();
            d.resolve(value);
          }}
        >
          <input
            ref={input}
            class="text-input"
            type={d.inputType ?? 'text'}
            value={value}
            placeholder={d.placeholder}
            aria-label={d.title}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            autoComplete={d.inputType === 'password' ? 'new-password' : 'off'}
          />
          <div class="dialog-actions">
            <Button variant="ghost" onClick={cancel}>
              Annuler
            </Button>
            <Button variant="primary" type="submit">
              {d.confirmLabel ?? 'Valider'}
            </Button>
          </div>
        </form>
      ) : d.kind === 'confirm' ? (
        <div class="dialog-actions">
          <Button variant="ghost" onClick={cancel}>
            Annuler
          </Button>
          <Button
            variant={d.danger ? 'danger' : 'primary'}
            onClick={() => {
              closeDialog();
              d.resolve(true);
            }}
          >
            {d.confirmLabel ?? 'Confirmer'}
          </Button>
        </div>
      ) : (
        <ul class="choice-list">
          {d.options.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                class="choice"
                onClick={() => {
                  closeDialog();
                  d.resolve(o.value);
                }}
              >
                <span>{o.label}</span>
                {o.hint ? <small>{o.hint}</small> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

function BusyOverlay() {
  const busy = useBusy();
  if (!busy) return null;
  return (
    <div class="busy-overlay" role="alertdialog" aria-live="assertive" aria-label={busy.label}>
      <div class="busy-card">
        <div class="spinner" aria-hidden="true" />
        <p>{busy.label}</p>
        <Progress {...(busy.progress !== undefined ? { value: busy.progress } : {})} label={busy.label} />
      </div>
    </div>
  );
}
