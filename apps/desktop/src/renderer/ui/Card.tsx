import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

type CardTone = 'surface' | 'muted';

interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'article' | 'div' | 'section';
  tone?: CardTone;
  children: ReactNode;
}

const toneClasses: Record<CardTone, string> = {
  surface:
    'border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] shadow-[var(--shadow-soft)]',
  muted:
    'border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)]',
};

export function Card({
  as = 'article',
  tone = 'surface',
  className,
  children,
  ...props
}: CardProps) {
  const Component = as;
  return (
    <Component
      className={cn(
        'flex items-center justify-between gap-4 rounded-[24px] border px-[1.15rem] py-[1.1rem]',
        toneClasses[tone],
        className,
      )}
      {...props}
    >
      {children}
    </Component>
  );
}

export function CardMain({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-w-0 flex-1', className)} {...props} />;
}

export function CardTitleRow({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-wrap items-center gap-[0.7rem]', className)}
      {...props}
    />
  );
}

export function CardMeta({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'mt-[0.45rem] flex flex-wrap gap-[0.8rem] text-[0.92rem] text-[var(--text-soft)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardActions({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex shrink-0 flex-wrap gap-[0.6rem]', className)}
      {...props}
    />
  );
}

export function CardMessage({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn('mt-[0.55rem] text-[var(--text-soft)]', className)}
      {...props}
    />
  );
}
