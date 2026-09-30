/**
 * Minimal type declarations for the parts of Bun used by tests and scripts.
 * (Kept local so type-checking works without installing @types/bun.)
 */
declare module 'bun:test' {
  interface Matchers<T> {
    not: Matchers<T>;
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toBeCloseTo(expected: number, digits?: number): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeNull(): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toContain(expected: unknown): void;
    toHaveLength(n: number): void;
    toMatch(re: RegExp | string): void;
    toThrow(msg?: string | RegExp): void;
    toBeInstanceOf(c: unknown): void;
    resolves: Matchers<Awaited<T>>;
    rejects: Matchers<unknown>;
  }
  export function expect<T>(value: T): Matchers<T>;
  export function test(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  export function it(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  export function describe(name: string, fn: () => void): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
}

declare module 'node:zlib' {
  export function inflateSync(buf: Uint8Array): Uint8Array;
  export function deflateSync(buf: Uint8Array): Uint8Array;
}

declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, enc: 'utf8'): string;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { size: number; isDirectory(): boolean };
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function cpSync(src: string, dst: string, opts?: { recursive?: boolean }): void;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function extname(p: string): string;
  export function relative(from: string, to: string): string;
}

declare module 'node:child_process' {
  export function execFileSync(cmd: string, args: string[], opts?: { input?: Uint8Array | string; encoding?: 'utf8' }): string;
  export function spawnSync(
    cmd: string,
    args: string[],
    opts?: { input?: Uint8Array | string; encoding?: 'utf8' },
  ): { status: number | null; stdout: string; stderr: string };
}

declare module 'node:os' {
  export function tmpdir(): string;
}

interface ImportMeta {
  dir: string;
  main: boolean;
}

interface BunBuildOutput {
  success: boolean;
  logs: unknown[];
  outputs: Array<{ path: string; kind: string }>;
}

interface BunServer {
  port: number;
  stop(): void;
}

declare const Bun: {
  build(opts: {
    entrypoints: string[];
    outdir: string;
    target?: 'browser' | 'bun' | 'node';
    format?: 'esm' | 'iife';
    minify?: boolean;
    sourcemap?: 'none' | 'linked' | 'external' | 'inline';
    splitting?: boolean;
    naming?: string | { entry?: string; chunk?: string; asset?: string };
    define?: Record<string, string>;
    jsx?: { runtime?: 'automatic' | 'classic'; importSource?: string };
  }): Promise<BunBuildOutput>;
  serve(opts: { port?: number; hostname?: string; fetch(req: Request): Response | Promise<Response> }): BunServer;
  file(path: string): Blob & { exists(): Promise<boolean>; type: string };
  write(path: string, data: string | Uint8Array | Blob): Promise<number>;
  argv: string[];
  env: Record<string, string | undefined>;
  CryptoHasher: new (alg: 'sha256' | 'sha1' | 'md5') => { update(d: string | Uint8Array): unknown; digest(enc: 'hex'): string };
};

declare const process: { exit(code?: number): never; argv: string[]; env: Record<string, string | undefined>; cwd(): string };
