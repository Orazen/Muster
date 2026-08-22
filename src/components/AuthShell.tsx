import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { StarLogo } from "@/pages/LandingPage";

/** Shared auth surface: the same dark canvas, orange glow, and star mark as
 * the landing page, so sign-in/sign-up read as one continuous brand instead
 * of a theme switch at the worst possible moment. Card styling follows
 * gaiaTheme (rounded-2xl, hairline border, soft shadow). */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0a0a0a] px-4 py-10">
      {/* ambient orange glow behind the card */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/3 h-[420px] w-[680px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.16]"
        style={{ background: "radial-gradient(closest-side, #f0460e, transparent)" }}
      />
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <Link to="/" aria-label="Muster home" className="transition-opacity hover:opacity-80">
            <StarLogo size={40} />
          </Link>
          <h1 className="mt-5 text-[26px] font-bold tracking-[-0.02em] text-[#f5f5f5]">{title}</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-[#a1a1a6]">{subtitle}</p>
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-[#101012] p-6 shadow-[0_30px_80px_rgba(0,0,0,.5)]">
          {children}
        </div>

        {footer && <div className="mt-6 text-center text-sm text-[#a1a1a6]">{footer}</div>}
      </div>
    </div>
  );
}

/** Shared field styling for the dark auth surface. Inputs sit on inset white
 * glass so focus states read against both the card and the glow. */
export const authInputCls =
  "w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2.5 text-[14px] text-[#f5f5f5] placeholder-[#6b6b70] transition-colors focus:border-[#f0460e]/60 focus:bg-white/[0.06] focus:outline-none focus:ring-1 focus:ring-[#f0460e]/50";

export const authButtonCls =
  "w-full rounded-lg bg-[#f0460e] py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(240,70,14,.28)] transition-all hover:-translate-y-px hover:bg-[#f0460e]/90 hover:shadow-[0_12px_28px_rgba(240,70,14,.38)] disabled:pointer-events-none disabled:opacity-50";

export const authCardBox =
  "rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-[13px] leading-relaxed";
