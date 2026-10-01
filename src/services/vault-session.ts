import type { Library } from './library';

/**
 * Temporary openings of locked documents. The password is kept in memory only (never stored) for
 * as long as the document is open; the document is locked again as soon as the user leaves it or
 * the app goes to the background. If the app is closed in between, the document keeps its
 * `relockPending` flag and the UI asks to lock it again.
 */
export class VaultSession {
  private passwords = new Map<string, string>();
  private pending = new Map<string, Promise<unknown>>();

  constructor(private readonly lib: Library) {}

  isOpenInSession(id: string): boolean {
    return this.passwords.has(id);
  }

  async open(id: string, password: string): Promise<void> {
    await this.lib.unlockDocument(id, password, true);
    this.passwords.set(id, password);
  }

  /** Locks a document again with the password used to open it. */
  async relock(id: string): Promise<boolean> {
    const pw = this.passwords.get(id);
    if (pw === undefined) return false;
    const running = this.pending.get(id);
    if (running) {
      await running;
      return true;
    }
    const doc = this.lib.get(id);
    this.passwords.delete(id);
    if (!doc || doc.locked || !doc.relockPending) return false;
    const p = this.lib.lockDocument(id, pw, true).finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    await p;
    return true;
  }

  /** Locks every temporarily opened document except `keepId`. */
  async relockAll(keepId: string | null = null): Promise<number> {
    let n = 0;
    for (const id of [...this.passwords.keys()]) if (id !== keepId && (await this.relock(id))) n++;
    return n;
  }

  /** The user removed the lock: forget the password and the pending re-lock. */
  async removeLock(id: string): Promise<void> {
    this.passwords.delete(id);
    await this.lib.keepUnlocked(id);
  }
}
