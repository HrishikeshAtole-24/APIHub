import Link from 'next/link';

import { Icon } from '@/components/ui/Icon';

import styles from './Footer.module.css';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { href: '/explore', label: 'Explore APIs' },
      { href: '/playground', label: 'Playground' },
      { href: '/compare', label: 'Compare' },
      { href: '/assistant', label: 'AI Assistant' },
    ],
  },
  {
    title: 'Monitoring',
    links: [
      { href: '/health', label: 'Status board' },
      { href: '/categories', label: 'Categories' },
    ],
  },
  {
    title: 'Account',
    links: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/favorites', label: 'Favorites' },
      { href: '/collections', label: 'Collections' },
    ],
  },
] as const;

export function Footer() {
  return (
    <footer className={styles['footer']}>
      <div className="container-wide">
        <div className={styles['grid']}>
          <div className={styles['brandBlock']}>
            <Link href="/" className={styles['brand']}>
              <span className={styles['mark']} aria-hidden="true">
                <Icon name="hexagon" size={14} />
              </span>
              APIHub
            </Link>
            <p className={styles['tagline']}>
              Discover, test, compare and monitor public APIs. Built as a study in production
              engineering: search ranking, health monitoring and a hardened request proxy.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.title}>
              <h2 className={styles['columnTitle']}>{column.title}</h2>
              <ul className={styles['links']}>
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className={styles['link']}>
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className={styles['bottom']}>
          <span>© {new Date().getFullYear()} APIHub</span>

          {/*
            Attribution is a licence obligation, not decoration: the catalogue
            is derived from the MIT-licensed public-apis project (report 16.1).
          */}
          <span className={styles['attribution']}>
            <Icon name="database" size={13} />
            Catalogue data from{' '}
            <a
              href="https://github.com/public-apis/public-apis"
              target="_blank"
              rel="noopener noreferrer"
            >
              public-apis
            </a>{' '}
            (MIT)
          </span>
        </div>
      </div>
    </footer>
  );
}
