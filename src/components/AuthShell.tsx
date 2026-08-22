import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { MusterbotMark } from "./MusterbotMark";

/** Shared auth surface — musterbot.app scene style: warm light background,
 * the animated mark large behind/beside the form, MUSTER wordmark footer.
 * Clean, no dark canvas, no glow. */
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
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#f9f9f9] px-4 py-8">
      {/* Large animated mark above the form, musterbot scene style */}
      <Link to="/" aria-label="Muster home" className="mb-6 transition-opacity hover:opacity-80">
        <MusterbotMark size={140} />
      </Link>

      <div className="w-full max-w-[380px]">
        <h1 className="text-center text-[24px] font-semibold tracking-[-0.02em] text-[#111]">{title}</h1>
        <p className="mt-1.5 text-center text-[14px] leading-relaxed text-[#666]">{subtitle}</p>
        <div className="mt-6">{children}</div>
        {footer && <div className="mt-5 text-center text-[13px] text-[#888]">{footer}</div>}
      </div>

      {/* MUSTER wordmark footer */}
      <span
        aria-hidden="true"
        className="mt-auto pt-10 text-[13px] font-bold uppercase tracking-[0.42em] text-[#d4d4d4]"
      >
        Muster
      </span>
    </div>
  );
}

export const authInputCls =
  "w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-[14px] text-[#111] placeholder:text-gray-400 transition-colors focus:border-[#f0460e] focus:outline-none focus:ring-1 focus:ring-[#f0460e]/30";

export const authButtonCls =
  "w-full rounded-lg bg-[#f0460e] py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#d93e0c] disabled:opacity-50";

export const authCardBox =
  "rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-[13px] leading-relaxed";
