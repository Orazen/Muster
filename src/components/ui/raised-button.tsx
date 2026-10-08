/**
 * Adapted from GAIA UI RaisedButton, Copyright (c) 2026 The Experience Company.
 * Source: https://github.com/theexperiencecompany/gaia-ui/blob/14e20153ff1fa89897e2e90aa13eb17c69d4b156/registry/new-york/ui/raised-button.tsx
 * Upstream commit: 14e20153ff1fa89897e2e90aa13eb17c69d4b156 (MIT).
 * Full license: public/third-party-notices.txt, included in application builds.
 * Adaptations: Muster tokens, a quieter raised edge, standard control variants,
 * Slot composition, neutral focus, reduced motion and explicit color contrast.
 */
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/cn";
import { getLuminance, parseColor } from "@/lib/color-utils";

const buttonVariants = cva(
  "gaia-button relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[background-color,border-color,box-shadow,transform] duration-150 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-[color:var(--gaia-button-edge)] bg-[color:var(--gaia-button-fill)] text-[color:var(--gaia-button-ink)] shadow-[var(--gaia-button-shadow)] enabled:hover:bg-[color:var(--gaia-button-hover)] data-[slot-link]:hover:bg-[color:var(--gaia-button-hover)] active:translate-y-px active:shadow-[var(--gaia-button-pressed)] motion-reduce:active:translate-y-0",
        destructive:
          "border border-danger/35 bg-danger/10 text-danger hover:bg-danger/15",
        outline:
          "border border-hairline bg-transparent text-ink hover:bg-raised",
        secondary:
          "border border-hairline bg-raised text-ink shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)] hover:bg-raised-hover",
        ghost:
          "border border-transparent bg-transparent text-ink-secondary hover:bg-raised hover:text-ink",
        link:
          "border border-transparent bg-transparent text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 rounded-xl px-4 py-2",
        sm: "h-9 rounded-lg px-3",
        lg: "h-11 rounded-lg px-8",
        icon: "size-10 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface RaisedButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Optional explicit primary fill. Other variants retain their semantic color. */
  color?: string;
  asChild?: boolean;
}

const RaisedButton = React.forwardRef<HTMLButtonElement, RaisedButtonProps>(
  ({ className, variant = "default", size, color, style, asChild = false, ...props }, ref) => {
    const dynamicStyles = React.useMemo(() => {
      if (!color || variant !== "default") return undefined;
      const rgb = parseColor(color);
      if (!rgb || ![rgb.r, rgb.g, rgb.b].every(value => Number.isFinite(value) && value >= 0 && value <= 255)) return undefined;
      const luminance = getLuminance(rgb);
      // Choose the stronger black/white contrast, including mid-tone crew colors.
      const ink = (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
      // SAFETY: these string-valued CSS custom properties are valid inline styles but absent from React.CSSProperties' named-property type.
      return {
        "--gaia-button-fill": color,
        "--gaia-button-ink": ink,
        // Move away from the foreground on hover so its contrast cannot fall.
        "--gaia-button-hover": `color-mix(in srgb, ${color} 94%, ${ink === "#000000" ? "white" : "black"})`,
      } as React.CSSProperties;
    }, [color, variant]);

    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        data-slot-link={asChild ? "" : undefined}
        className={cn(buttonVariants({ variant, size }), className)}
        style={{ ...dynamicStyles, ...style }}
        {...props}
      />
    );
  },
);
RaisedButton.displayName = "RaisedButton";

export { buttonVariants, RaisedButton };
