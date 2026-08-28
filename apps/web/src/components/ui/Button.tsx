import Link from 'next/link';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders as a square icon button; children should be a single icon. */
  iconOnly?: boolean;
  fullWidth?: boolean;
  loading?: boolean;
  children?: ReactNode;
  className?: string;
}

function classNames(props: CommonProps): string {
  const { variant = 'primary', size = 'md', iconOnly, fullWidth, loading, className } = props;

  return [
    styles['button'],
    styles[variant],
    size !== 'md' ? styles[size] : '',
    iconOnly ? styles['icon'] : '',
    fullWidth ? styles['full'] : '',
    loading ? styles['loading'] : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

export type ButtonProps = CommonProps & ComponentPropsWithoutRef<'button'>;

export function Button({
  variant,
  size,
  iconOnly,
  fullWidth,
  loading,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      // `aria-busy` tells assistive tech the control is working, which a
      // purely visual spinner does not communicate.
      aria-busy={loading || undefined}
      disabled={disabled ?? loading}
      className={classNames({ variant, size, iconOnly, fullWidth, loading, className })}
    >
      {loading ? <span className={styles['spinner']} aria-hidden="true" /> : null}
      <span className={styles['label']}>{children}</span>
    </button>
  );
}

export type ButtonLinkProps = CommonProps &
  Omit<ComponentPropsWithoutRef<typeof Link>, 'className'>;

/** A link that looks like a button. Uses <a> semantics, so it navigates. */
export function ButtonLink({
  variant,
  size,
  iconOnly,
  fullWidth,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link {...rest} className={classNames({ variant, size, iconOnly, fullWidth, className })}>
      <span className={styles['label']}>{children}</span>
    </Link>
  );
}
