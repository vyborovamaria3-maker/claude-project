import * as React from 'react';
import { cn } from '@/client/lib/utils';
import { CONTROL_BASE, variantColorClasses, DEFAULT_VARIANT, DEFAULT_COLOR, type Variant, type Color } from './_shared/variants';
import { SIZES, ICON_GLYPH, DEFAULT_SIZE, type ControlSize } from './_shared/sizes';
import { useButtonGroup } from './_shared/buttonGroup';
import { Spinner } from './Spinner';

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  variant?: Variant;
  color?: Color;
  size?: ControlSize;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({
  className, variant: variantProp, color: colorProp, size: sizeProp,
  loading = false, leftIcon, rightIcon, disabled, children, ...props
}, ref) => {
  const group = useButtonGroup();
  const variant = variantProp ?? group?.variant ?? DEFAULT_VARIANT;
  const color = colorProp ?? group?.color ?? DEFAULT_COLOR;
  const size = sizeProp ?? group?.size ?? DEFAULT_SIZE;
  return (
    <button
      ref={ref}
      type="button"
      className={cn(CONTROL_BASE, SIZES[size], variantColorClasses(variant, color), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner className={ICON_GLYPH[size]} /> : leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});
Button.displayName = 'Button';
export { Button };
