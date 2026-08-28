import type { Metadata } from 'next';

import { AuthForm } from '@/features/auth/AuthForm';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to your APIHub account.',
  robots: { index: false, follow: false },
};

export default async function LoginPage(props: PageProps<'/login'>) {
  const params = await props.searchParams;
  const next = typeof params['next'] === 'string' ? params['next'] : '/dashboard';

  return (
    <div className="container">
      <AuthForm mode="login" redirectTo={next} />
    </div>
  );
}
