import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'cursor-pointer inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.97]',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline:
          'border border-input bg-background hover:bg-accent hover:text-foreground',
        secondary:
          'bg-secondary text-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * ARIA label for screen readers when button text is not descriptive enough
   */
  'aria-label'?: string;
  /**
   * ARIA describedby for additional description
   */
  'aria-describedby'?: string;
  /**
   * ARIA expanded state for buttons that control expandable content
   */
  'aria-expanded'?: boolean;
  /**
   * ARIA pressed state for toggle buttons
   */
  'aria-pressed'?: boolean;
  /**
   * ARIA controls for buttons that control other elements
   */
  'aria-controls'?: string;
  /**
   * ARIA live region for buttons that trigger dynamic content changes
   */
  'aria-live'?: 'polite' | 'assertive' | 'off';
  /**
   * Loading state for buttons that trigger async actions
   */
  loading?: boolean;
  /**
   * Loading text to show when button is in loading state
   */
  loadingText?: string;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      loadingText,
      disabled,
      children,
      'aria-label': ariaLabel,
      'aria-describedby': ariaDescribedby,
      'aria-expanded': ariaExpanded,
      'aria-pressed': ariaPressed,
      'aria-controls': ariaControls,
      'aria-live': ariaLive,
      ...props
    },
    ref
  ) => {
    // Determine if button should be disabled
    const isDisabled = disabled || loading;

    // Handle loading state
    const buttonContent = loading && loadingText ? loadingText : children;

    // Build ARIA attributes object
    const ariaAttributes: React.AriaAttributes = {};
    if (ariaLabel) ariaAttributes['aria-label'] = ariaLabel;
    if (ariaDescribedby) ariaAttributes['aria-describedby'] = ariaDescribedby;
    if (ariaExpanded !== undefined)
      ariaAttributes['aria-expanded'] = ariaExpanded;
    if (ariaPressed !== undefined) ariaAttributes['aria-pressed'] = ariaPressed;
    if (ariaControls) ariaAttributes['aria-controls'] = ariaControls;
    if (ariaLive) ariaAttributes['aria-live'] = ariaLive;

    // Add loading state to ARIA label if loading
    if (loading && ariaLabel) {
      ariaAttributes['aria-label'] = `${ariaLabel} (loading)`;
    } else if (loading && !ariaLabel && typeof children === 'string') {
      ariaAttributes['aria-label'] = `${children} (loading)`;
    }

    if (asChild) {
      return (
        <Slot
          className={cn(buttonVariants({ variant, size, className }))}
          ref={ref}
          {...ariaAttributes}
          {...props}
        >
          {children}
        </Slot>
      );
    }

    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={isDisabled}
        {...ariaAttributes}
        {...props}
      >
        {loading && (
          <svg
            className="mr-2 h-4 w-4 animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {buttonContent}
      </button>
    );
  }
);

Button.displayName = 'Button';

export { Button, buttonVariants };
