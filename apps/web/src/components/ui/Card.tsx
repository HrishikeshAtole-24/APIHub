import type { ReactNode } from 'react';

import styles from './Card.module.css';

interface CardProps {
  children: ReactNode;
  /** Adds hover lift + accent hairline. Use only when the card is clickable. */
  interactive?: boolean;
  padded?: boolean;
  className?: string;
  as?: 'div' | 'article' | 'section' | 'li';
}

export function Card({
  children,
  interactive,
  padded,
  className,
  as: Tag = 'div',
}: CardProps) {
  return (
    <Tag
      className={[
        styles['card'],
        interactive ? `${styles['interactive']} ${styles['glow']}` : '',
        padded ? styles['padded'] : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  bordered,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  bordered?: boolean;
}) {
  return (
    <div className={[styles['header'], bordered ? styles['headerBordered'] : ''].join(' ')}>
      <div>
        <h3 className={styles['title']}>{title}</h3>
        {subtitle ? <p className={styles['subtitle']}>{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function CardBody({
  children,
  tight,
  className,
}: {
  children: ReactNode;
  tight?: boolean;
  className?: string;
}) {
  return (
    <div className={[tight ? styles['bodyTight'] : styles['body'], className ?? ''].join(' ')}>
      {children}
    </div>
  );
}

export function CardFooter({ children }: { children: ReactNode }) {
  return <div className={styles['footer']}>{children}</div>;
}

export function Sunken({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={[styles['sunken'], className ?? ''].join(' ')}>{children}</div>;
}
