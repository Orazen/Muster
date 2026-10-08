import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/cn";
import {
  RaisedButton,
  buttonVariants as raisedButtonVariants,
  type RaisedButtonProps,
} from "./raised-button";

// Keep the shared Button's established sizing while using the actual vendored
// GAIA primitive for its surface, semantics and ref/Slot handling.
const buttonSizes = cva("[&_svg]:size-4", {
  variants: {
    size: {
      default: "h-9 rounded-lg px-4 py-2",
      sm: "h-8 rounded-md px-3 text-xs",
      lg: "h-10 rounded-lg px-6",
      icon: "size-9 p-0",
    },
  },
  defaultVariants: { size: "default" },
});

type ButtonProps = Omit<RaisedButtonProps, "color">;

function buttonVariants({ variant, size, className }: Pick<ButtonProps, "variant" | "size" | "className"> = {}) {
  return cn(raisedButtonVariants({ variant, size }), buttonSizes({ size }), className);
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <RaisedButton
      ref={ref}
      variant={variant}
      size={size}
      className={cn(buttonSizes({ size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { Button, buttonVariants };
