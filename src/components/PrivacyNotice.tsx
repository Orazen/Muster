// One-line transcript marker for Privacy Shield: what got masked before
// this turn left for a cloud model. Counts only by construction — the store
// never persists the masked values, so the chip can't leak what it hides.
export function PrivacyNotice({
  privacy,
}: {
  privacy: { secrets: number; emails: number; phones: number };
}) {
  const parts = [
    privacy.secrets > 0 && `${privacy.secrets} secret${privacy.secrets === 1 ? "" : "s"}`,
    privacy.emails > 0 && `${privacy.emails} email${privacy.emails === 1 ? "" : "s"}`,
    privacy.phones > 0 && `${privacy.phones} phone number${privacy.phones === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return (
    <div className="flex justify-center py-1" role="status">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12px] text-ink-secondary">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0">
          <path
            d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
        Privacy Shield masked {parts.join(", ")}
      </span>
    </div>
  );
}
