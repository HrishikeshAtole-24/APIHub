'use client';

import type { PublicUser } from '@apihub/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { ApiError, api } from '@/lib/api-client';
import { useSession } from './SessionProvider';

import styles from './AuthForm.module.css';

interface AuthFormProps {
  mode: 'login' | 'register';
  /** Path to return to after a successful sign-in. */
  redirectTo?: string;
}

export function AuthForm({ mode, redirectTo = '/dashboard' }: AuthFormProps) {
  const isRegister = mode === 'register';

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const router = useRouter();
  const { refresh } = useSession();
  const toast = useToast();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFieldErrors({});
    setFormError(null);
    setSubmitting(true);

    try {
      await api.post<{ user: PublicUser }>(
        isRegister ? '/v1/auth/register' : '/v1/auth/login',
        isRegister ? { email, name, password } : { email, password },
      );

      // Pull the new session (and CSRF token) into context before navigating,
      // so the destination page renders signed-in immediately.
      await refresh();
      toast.success(isRegister ? 'Welcome to APIHub' : 'Signed in');

      router.push(redirectTo as never);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError) {
        // Field-level detail comes from the API's Zod validation, so the form
        // shows the same rules the server enforces.
        if (error.details && error.details.length > 0) {
          const mapped: Record<string, string> = {};
          for (const detail of error.details) mapped[detail.path] = detail.message;
          setFieldErrors(mapped);
        } else {
          setFormError(error.userMessage);
        }
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const fillDemo = () => {
    setEmail('demo@apihub.dev');
    setPassword('apihub-demo-password');
  };

  return (
    <div className={styles['wrap']}>
      <div className={styles['card']}>
        <h1 className={styles['title']}>{isRegister ? 'Create an account' : 'Welcome back'}</h1>
        <p className={styles['subtitle']}>
          {isRegister
            ? 'Save favorites, build collections and review APIs.'
            : 'Sign in to your APIHub account.'}
        </p>

        <form onSubmit={submit} noValidate>
          {formError ? (
            <p className={styles['formError']} role="alert">
              {formError}
            </p>
          ) : null}

          {isRegister ? (
            <div className={styles['field']}>
              <label className={styles['label']} htmlFor="name">
                Name
              </label>
              <input
                id="name"
                className={[styles['input'], fieldErrors['name'] ? styles['inputError'] : '']
                  .filter(Boolean)
                  .join(' ')}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                required
                aria-invalid={Boolean(fieldErrors['name'])}
              />
              {fieldErrors['name'] ? (
                <p className={styles['error']}>{fieldErrors['name']}</p>
              ) : null}
            </div>
          ) : null}

          <div className={styles['field']}>
            <label className={styles['label']} htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              className={[styles['input'], fieldErrors['email'] ? styles['inputError'] : '']
                .filter(Boolean)
                .join(' ')}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              aria-invalid={Boolean(fieldErrors['email'])}
            />
            {fieldErrors['email'] ? (
              <p className={styles['error']}>{fieldErrors['email']}</p>
            ) : null}
          </div>

          <div className={styles['field']}>
            <label className={styles['label']} htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              className={[styles['input'], fieldErrors['password'] ? styles['inputError'] : '']
                .filter(Boolean)
                .join(' ')}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              required
              aria-invalid={Boolean(fieldErrors['password'])}
            />
            {fieldErrors['password'] ? (
              <p className={styles['error']}>{fieldErrors['password']}</p>
            ) : isRegister ? (
              <p className={styles['hint']}>
                At least 12 characters. Length matters far more than symbols.
              </p>
            ) : null}
          </div>

          <Button type="submit" fullWidth loading={submitting}>
            {isRegister ? 'Create account' : 'Sign in'}
          </Button>
        </form>

        {!isRegister ? (
          <div className={styles['demo']}>
            Exploring this project? Use the demo account:
            <br />
            <code>demo@apihub.dev</code> / <code>apihub-demo-password</code>
            <Button
              size="sm"
              variant="secondary"
              className={styles['demoButton']}
              onClick={fillDemo}
            >
              Fill demo credentials
            </Button>
          </div>
        ) : null}

        <p className={styles['footer']}>
          {isRegister ? (
            <>
              Already have an account? <Link href="/login">Sign in</Link>
            </>
          ) : (
            <>
              New here? <Link href="/register">Create an account</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
