'use client';

import { AUTH_TYPE_LABELS, HEALTH_STATUS_LABELS } from '@apihub/contracts';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Icon } from '@/components/ui/Icon';

import styles from '@/app/explore/explore.module.css';

/** Human labels for the boolean feature filters. */
const BOOLEAN_LABELS: Record<string, string> = {
  free: 'Free to use',
  https: 'HTTPS',
  cors: 'CORS enabled',
};

/**
 * Removable chips for the filters currently applied.
 *
 * Without these, an active filter is only visible if the sidebar happens to be
 * in view — which on mobile it never is. A user seeing "0 results" needs to
 * know why at a glance.
 */
export function ActiveChips() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const chips: { key: string; label: string }[] = [];

  for (const [key, label] of Object.entries(BOOLEAN_LABELS)) {
    if (searchParams.get(key) === 'true') chips.push({ key, label });
  }

  const auth = searchParams.get('auth');
  if (auth) {
    chips.push({
      key: 'auth',
      label: `Auth: ${AUTH_TYPE_LABELS[auth as keyof typeof AUTH_TYPE_LABELS] ?? auth}`,
    });
  }

  const status = searchParams.get('status');
  if (status) {
    chips.push({
      key: 'status',
      label: `Status: ${HEALTH_STATUS_LABELS[status as keyof typeof HEALTH_STATUS_LABELS] ?? status}`,
    });
  }

  const category = searchParams.get('category');
  if (category) chips.push({ key: 'category', label: `Category: ${category}` });

  if (chips.length === 0) return null;

  const remove = (key: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete(key);
    params.delete('page');
    const query = params.toString();
    router.push((query ? `${pathname}?${query}` : pathname) as never, { scroll: false });
  };

  return (
    <div className={styles['chips']}>
      {chips.map((chip) => (
        <span key={chip.key} className={styles['chip']}>
          {chip.label}
          <button
            type="button"
            className={styles['chipRemove']}
            onClick={() => remove(chip.key)}
            aria-label={`Remove filter: ${chip.label}`}
          >
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}
