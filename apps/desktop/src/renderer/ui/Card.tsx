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
    'border-[var(--border)] bg-[var(--surface-elevated)] shadow-none',
  muted:
    'border-[var(--border)] bg-[var(--surface-muted)] shadow-none',
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
        'flex items-center justify-between gap-4 rounded-[12px] border px-[0.9rem] py-[0.9rem]',
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
        'mt-[0.4rem] flex flex-wrap gap-[0.9rem] text-[0.9rem] text-[var(--text-soft)]',
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
      className={cn('flex shrink-0 flex-wrap gap-[0.55rem]', className)}
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
