'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { useSession } from '@/features/auth/SessionProvider';
import { CommandPalette } from '@/features/search/CommandPalette';
import { ThemeToggle } from './ThemeToggle';
import { Icon } from '@/components/ui/Icon';

import styles from './Header.module.css';

const NAV_LINKS = [
  { href: '/explore', label: 'Explore' },
  { href: '/playground', label: 'Playground' },
  { href: '/health', label: 'Status' },
  { href: '/assistant', label: 'Assistant' },
] as const;

export function Header() {
  const pathname = usePathname();
  const { user, isAuthenticated, signOut } = useSession();

  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the user menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  // Navigating away should always dismiss transient UI.
  useEffect(() => {
    setMenuOpen(false);
    setMobileOpen(false);
  }, [pathname]);

  // Cmd/Ctrl-K opens search from anywhere, the convention for developer tools.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      <header className={styles['header']}>
        <div className={`container-wide ${styles['inner']}`}>
          <Link href="/" className={styles['brand']} aria-label="APIHub home">
            <span className={styles['mark']} aria-hidden="true">
              <Icon name="hexagon" size={15} />
            </span>
            <span className={styles['brandName']}>
              API<em>Hub</em>
            </span>
          </Link>

          <nav className={styles['nav']} aria-label="Main">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={[
                  styles['navLink'],
                  isActive(link.href) ? styles['navLinkActive'] : '',
                ].join(' ')}
                aria-current={isActive(link.href) ? 'page' : undefined}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <span className={styles['spacer']} />

          <div className={styles['actions']}>
            <button
              type="button"
              className={styles['searchTrigger']}
              onClick={() => setPaletteOpen(true)}
              aria-label="Search APIs"
            >
              <Icon name="search" size={14} />
              <span className={styles['searchTriggerLabel']}>Search APIs…</span>
              <kbd className={styles['kbd']}>⌘K</kbd>
            </button>

            <ThemeToggle />

            {isAuthenticated && user ? (
              <div className={styles['menuWrap']} ref={menuRef}>
                <button
                  type="button"
                  className={styles['userButton']}
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                >
                  <span
                    className={styles['avatar']}
                    style={{ background: user.avatarColor }}
                    aria-hidden="true"
                  >
                    {user.name.charAt(0).toUpperCase()}
                  </span>
                  <span className={`${styles['userName']} truncate`}>{user.name}</span>
                  <Icon name="chevron-down" size={13} />
                </button>

                {menuOpen ? (
                  <div className={styles['menu']} role="menu">
                    <div className={styles['menuHeader']}>
                      <div className={styles['userName']}>{user.name}</div>
                      <div className={styles['menuEmail']}>{user.email}</div>
                    </div>

                    <Link href="/dashboard" className={styles['menuItem']} role="menuitem">
                      <Icon name="layout-dashboard" size={15} />
                      Dashboard
                    </Link>
                    <Link href="/favorites" className={styles['menuItem']} role="menuitem">
                      <Icon name="heart" size={15} />
                      Favorites
                    </Link>
                    <Link href="/collections" className={styles['menuItem']} role="menuitem">
                      <Icon name="folder" size={15} />
                      Collections
                    </Link>

                    {user.role === 'admin' ? (
                      <>
                        <div className={styles['menuDivider']} />
                        <Link href="/admin" className={styles['menuItem']} role="menuitem">
                          <Icon name="shield" size={15} />
                          Admin
                        </Link>
                      </>
                    ) : null}

                    <div className={styles['menuDivider']} />
                    <button
                      type="button"
                      className={`${styles['menuItem']} ${styles['menuDanger']}`}
                      onClick={() => void signOut()}
                      role="menuitem"
                    >
                      <Icon name="log-out" size={15} />
                      Sign out
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <Link href="/login" className={styles['navLink']}>
                Sign in
              </Link>
            )}

            <button
              type="button"
              className={`${styles['iconButton']} ${styles['mobileToggle']}`}
              onClick={() => setMobileOpen((open) => !open)}
              aria-label="Toggle navigation"
              aria-expanded={mobileOpen}
            >
              <Icon name={mobileOpen ? 'x' : 'menu'} size={17} />
            </button>
          </div>
        </div>
      </header>

      {mobileOpen ? (
        <nav className={styles['mobileNav']} aria-label="Mobile">
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className={styles['mobileNavLink']}>
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}
