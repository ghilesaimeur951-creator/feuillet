export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span class="logo">
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M8 3h11l7 7v17a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" fill="var(--logo-paper)" stroke="var(--logo-ink)" stroke-width="2" stroke-linejoin="round" />
        <path d="M19 3v7h7" fill="none" stroke="var(--logo-ink)" stroke-width="2" stroke-linejoin="round" />
        <path d="M10.5 15.5 13 13l8 1 1 8-9-.5Z" fill="var(--logo-accent)" fill-opacity=".25" stroke="var(--logo-accent)" stroke-width="1.8" stroke-linejoin="round" />
      </svg>
      {compact ? null : <span class="logo-text">Feuillet</span>}
    </span>
  );
}
