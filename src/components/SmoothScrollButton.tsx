import { Button } from '@/components/ui/button';
import type { ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface SmoothScrollButtonProps extends ButtonProps {
  targetId: string;
  children: React.ReactNode;
  className?: string;
}

export const SmoothScrollButton = ({
  targetId,
  children,
  className,
  ...props
}: SmoothScrollButtonProps) => {
  return (
    <Button
      asChild
      className={cn('cursor-pointer transition-colors', className)}
      {...props}
    >
      <a href={`#${targetId}`}>{children}</a>
    </Button>
  );
};
