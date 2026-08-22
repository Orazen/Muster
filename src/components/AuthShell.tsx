import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { MusterbotMark } from "./MusterbotMark";

/** Shared auth surface — vellum.ai/account/signup style: clean white page,
 * centered musterbot mark, one heading, generous whitespace. No dark canvas,
 * no glow — just clarity. */
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
    <div className="flex min-h-screen items-center justify-center bg-white px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <Link to="/" aria-label="Muster home" className="transition-opacity hover:opacity-80">
            <MusterbotMark size={56} />
          </Link>
          <h1 className="mt-6 text-[24px] font-semibold tracking-[-0.02em] text-[#111]">{title}</h1>
          <p className="mt-1.5 text-[14px] leading-relaxed text-[#666]">{subtitle}</p>
        </div>

        <div>{children}</div>

        {footer && <div className="mt-5 text-center text-[13px] text-[#888]">{footer}</div>}
      </div>
    </div>
  );
}

export const authInputCls =
  "w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-[14px] text-[#111] placeholder:text-gray-400 transition-colors focus:border-[#f0460e] focus:outline-none focus:ring-1 focus:ring-[#f0460e]/30";

export const authButtonCls =
  "w-full rounded-lg bg-[#f0460e] py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#d93e0c] disabled:opacity-50";

export const authCardBox =
  "rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-[13px] leading-relaxed";
