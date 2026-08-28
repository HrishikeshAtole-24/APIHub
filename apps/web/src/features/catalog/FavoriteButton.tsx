'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { useSession } from '@/features/auth/SessionProvider';
import { ApiError, api } from '@/lib/api-client';

interface FavoriteButtonProps {
  apiId: string;
  initialFavorited: boolean;
  className?: string;
  activeClassName?: string;
  showLabel?: boolean;
}

/**
 * Favourite toggle with optimistic UI.
 *
 * The heart fills immediately and reverts if the request fails. Waiting for a
 * round-trip on a toggle this small makes the whole interface feel sluggish,
 * and the failure case is rare and fully recoverable.
 */
export function FavoriteButton({
  apiId,
  initialFavorited,
  className,
  activeClassName,
  showLabel,
}: FavoriteButtonProps) {
  const { isAuthenticated, csrfToken } = useSession();
  const [favorited, setFavorited] = useState(initialFavorited);
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();

  const toggle = async (event: React.MouseEvent) => {
    // The card wraps this in a stretched link; without these the click would
    // also navigate.
    event.preventDefault();
    event.stopPropagation();

    if (!isAuthenticated) {
      toast.info('Sign in to save favorites', 'Your list syncs across devices.');
      router.push('/login');
      return;
    }

    const next = !favorited;
    setFavorited(next);

    try {
      if (next) {
        await api.post(`/v1/me/favorites/${apiId}`, undefined, {
          csrfToken: csrfToken ?? undefined,
        });
      } else {
        await api.delete(`/v1/me/favorites/${apiId}`, { csrfToken: csrfToken ?? undefined });
      }

      // Refresh Server Components so any favorites list stays in step.
      startTransition(() => router.refresh());
    } catch (error) {
      setFavorited(!next); // roll back
      const message =
        error instanceof ApiError ? error.userMessage : 'Could not update your favorites.';
      toast.error('Something went wrong', message);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={[className ?? '', favorited ? (activeClassName ?? '') : ''].filter(Boolean).join(' ')}
      aria-pressed={favorited}
      aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
      title={favorited ? 'Remove from favorites' : 'Add to favorites'}
      disabled={pending}
    >
      <Icon name="heart" size={15} filled={favorited} />
      {showLabel ? <span>{favorited ? 'Saved' : 'Save'}</span> : null}
    </button>
  );
}
