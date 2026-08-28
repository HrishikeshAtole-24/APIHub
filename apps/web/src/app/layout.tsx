import type { Metadata, Viewport } from 'next';

import { Header } from '@/components/shell/Header';
import { Footer } from '@/components/shell/Footer';
import { ThemeScript } from '@/components/shell/ThemeScript';
import { SessionProvider } from '@/features/auth/SessionProvider';
import { ToastProvider } from '@/components/ui/Toast';
import { getSession } from '@/lib/session';

import '@/styles/global.css';

const SITE_URL = process.env['NEXT_PUBLIC_SITE_URL'] ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'APIHub — Discover, test and monitor public APIs',
    // Page titles fill the %s, so every page is self-describing in a tab strip.
    template: '%s · APIHub',
  },
  description:
    'Search thousands of public APIs, test them in the browser, compare them side by side and watch their uptime in real time.',
  keywords: ['public apis', 'api directory', 'api testing', 'rest api', 'free apis'],
  authors: [{ name: 'APIHub' }],
  openGraph: {
    type: 'website',
    siteName: 'APIHub',
    title: 'APIHub — Discover, test and monitor public APIs',
    description:
      'Search thousands of public APIs, test them in the browser, compare them side by side and watch their uptime in real time.',
    url: SITE_URL,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'APIHub',
    description: 'Discover, test and monitor public APIs.',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The browser chrome should match the app in both themes.
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#08090d' },
    { media: '(prefers-color-scheme: light)', color: '#fbfbfd' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolved on the server so the header renders in its signed-in state on the
  // first paint, with no authentication flicker.
  const session = await getSession();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>

        <SessionProvider initialSession={session}>
          <ToastProvider>
            <Header />
            <main id="main">{children}</main>
            <Footer />
          </ToastProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
