import { useState } from 'preact/hooks';
import type { DocumentRecord } from '../../core/docs/model';
import { pageCount } from '../../core/docs/model';
import { WrongPasswordError } from '../../core/security/vault';
import { moveFlow, renameFlow, trashWithUndo } from '../../app/actions';
import { goBack, navigate } from '../../app/router';
import { errorMessage, setBusy, useLibrary, vault } from '../../app/state';
import { Icon } from './Icon';
import { ActionList, Button, formatDate, IconButton, Sheet } from './ui';

/** Screen shown for a locked document: password form, plus the actions that need no decryption. */
export function LockedDocument({ doc }: { doc: DocumentRecord }) {
  const lib = useLibrary();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const n = pageCount(doc);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!password) return;
    setError(null);
    setBusy({ label: 'Déchiffrement…' });
    try {
      await vault().open(doc.id, password);
      setPassword('');
    } catch (err) {
      setError(err instanceof WrongPasswordError ? 'Mot de passe incorrect. Réessayez.' : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="page doc-page">
      <header class="top-bar">
        <IconButton icon="back" label="Retour" onClick={() => goBack('/')} />
        <h1>{doc.title}</h1>
        <IconButton
          icon="star"
          label={doc.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
          active={doc.favorite}
          onClick={() => void lib.toggleFavorite(doc.id)}
        />
        <IconButton icon="more" label="Plus d’actions" onClick={() => setMenu(true)} />
      </header>
      <form class="locked-panel" onSubmit={submit} data-testid="locked-panel">
        <div class="empty-icon">
          <Icon name="lock" size={40} />
        </div>
        <h2>Document verrouillé</h2>
        <p class="muted">
          {n} page{n > 1 ? 's' : ''} · verrouillé : {formatDate(doc.locked?.lockedAt ?? doc.updatedAt)}
          <br />
          Son contenu est chiffré sur cet appareil (AES-256). Saisissez le mot de passe pour l’ouvrir ; il sera verrouillé à nouveau dès que vous le
          quitterez.
        </p>
        <label class="field locked-field">
          <span>Mot de passe</span>
          <input
            class="text-input"
            type="password"
            autocomplete="current-password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'lock-error' : undefined}
            data-testid="unlock-password"
            autoFocus
          />
        </label>
        {error ? (
          <p id="lock-error" class="form-error" role="alert">
            <Icon name="alert" size={16} /> {error}
          </p>
        ) : null}
        <Button variant="primary" icon="lock" type="submit" disabled={!password} data-testid="unlock-submit">
          Ouvrir
        </Button>
      </form>
      <Sheet open={menu} onClose={() => setMenu(false)} title={doc.title}>
        <ActionList
          items={[
            { icon: 'pen', label: 'Renommer', onSelect: () => void renameFlow(doc) },
            { icon: 'folder', label: 'Déplacer dans un dossier', onSelect: () => void moveFlow([doc.id]) },
            {
              icon: 'trash',
              label: 'Mettre à la corbeille',
              danger: true,
              onSelect: async () => {
                await trashWithUndo([doc.id]);
                navigate('/', { replace: true });
              },
            },
          ]}
          onDone={() => setMenu(false)}
        />
      </Sheet>
    </div>
  );
}
