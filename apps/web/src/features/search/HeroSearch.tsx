'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';

import styles from './HeroSearch.module.css';

/**
 * Example queries.
 *
 * Chosen to demonstrate that the search understands INTENT, not just keywords:
 * "no auth" and "free" become filters, not search terms.
 */
const EXAMPLES = [
  'free weather API with no auth',
  'cryptocurrency prices',
  'geocoding',
  'CORS enabled',
];

export function HeroSearch() {
  const [query, setQuery] = useState('');
  const router = useRouter();

  const submit = (value: string) => {
    const trimmed = value.trim();
    router.push((trimmed ? `/explore?q=${encodeURIComponent(trimmed)}` : '/explore') as never);
  };

  return (
    <div className={styles['wrap']}>
      <form
        className={styles['form']}
        onSubmit={(event) => {
          event.preventDefault();
          submit(query);
        }}
        role="search"
      >
        <Icon name="search" size={18} className={styles['icon']} />
        <input
          className={styles['input']}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try: free weather API with no auth"
          aria-label="Search APIs"
          autoComplete="off"
        />
        <Button type="submit" size="md">
          Search
        </Button>
      </form>

      <div className={styles['examples']}>
        <span className={styles['exampleLabel']}>Try:</span>
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className={styles['example']}
            onClick={() => {
              setQuery(example);
              submit(example);
            }}
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
