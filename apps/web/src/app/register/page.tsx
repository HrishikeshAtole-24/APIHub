import type { Metadata } from 'next';

import { AuthForm } from '@/features/auth/AuthForm';

export const metadata: Metadata = {
  title: 'Create an account',
  description: 'Create an APIHub account to save favorites and build collections.',
  robots: { index: false, follow: false },
};

export default function RegisterPage() {
  return (
    <div className="container">
      <AuthForm mode="register" />
    </div>
  );
}
