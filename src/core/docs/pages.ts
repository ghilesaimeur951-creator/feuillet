import type { Adjustments, FilterId } from '../imaging/filters';
import type { Page } from './model';

/** Pure page-list operations used by the multi-page editor. Every function returns a new array. */

export function addPages(pages: readonly Page[], added: readonly Page[], at = pages.length): Page[] {
  const i = Math.max(0, Math.min(pages.length, at));
  return [...pages.slice(0, i), ...added, ...pages.slice(i)];
}

export function removePages(pages: readonly Page[], ids: readonly string[]): Page[] {
  const set = new Set(ids);
  return pages.filter((p) => !set.has(p.id));
}

/** Moves the page at `from` to index `to` (drag-and-drop reordering). */
export function movePage(pages: readonly Page[], from: number, to: number): Page[] {
  if (from < 0 || from >= pages.length) return pages.slice();
  const out = pages.slice();
  const [p] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, p as Page);
  return out;
}

export function duplicatePage(pages: readonly Page[], id: string, makeCopy: (p: Page) => Page): Page[] {
  const i = pages.findIndex((p) => p.id === id);
  if (i < 0) return pages.slice();
  return [...pages.slice(0, i + 1), makeCopy(pages[i] as Page), ...pages.slice(i + 1)];
}

export function replacePage(pages: readonly Page[], id: string, next: Page): Page[] {
  return pages.map((p) => (p.id === id ? next : p));
}

export function rotatePage(page: Page, turns: number): Page {
  const rotation = ((((page.rotation + turns) % 4) + 4) % 4) as Page['rotation'];
  const swap = Math.abs(turns) % 2 === 1;
  return { ...page, rotation, width: swap ? page.height : page.width, height: swap ? page.width : page.height };
}

export function setFilter(pages: readonly Page[], ids: readonly string[] | 'all', filter: FilterId, adjustments?: Adjustments): Page[] {
  const set = ids === 'all' ? null : new Set(ids);
  return pages.map((p) => (!set || set.has(p.id) ? { ...p, filter, ...(adjustments ? { adjustments } : {}) } : p));
}

/** Undo/redo stack for editor states (bounded). */
export class UndoStack<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(
    private present: T,
    private readonly limit = 50,
  ) {}

  get current(): T {
    return this.present;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  push(next: T): T {
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = next;
    this.future = [];
    return next;
  }

  undo(): T {
    const prev = this.past.pop();
    if (prev === undefined) return this.present;
    this.future.push(this.present);
    this.present = prev;
    return prev;
  }

  redo(): T {
    const next = this.future.pop();
    if (next === undefined) return this.present;
    this.past.push(this.present);
    this.present = next;
    return next;
  }

  /** Replaces the present state without recording history (external change, e.g. OCR finished). */
  sync(value: T): void {
    this.present = value;
  }

  reset(value: T): void {
    this.past = [];
    this.future = [];
    this.present = value;
  }
}
