'use client';

import type { RecommendResult } from '@apihub/contracts';
import Link from 'next/link';
import { useState } from 'react';

import { Badge, StatusPill } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { ApiError, api } from '@/lib/api-client';

import styles from './Assistant.module.css';

const EXAMPLES = [
  'I need a free weather API with no authentication for a hobby Node.js project',
  'Building an ecommerce app — what do I need for payments, email and shipping?',
  'Cryptocurrency prices that work directly from the browser',
  'Geocoding and reverse geocoding, must be free and CORS enabled',
  'Flight schedules and hotel data for a travel app',
];

export function Assistant() {
  const [prompt, setPrompt] = useState('');
  const [free, setFree] = useState(false);
  const [noAuth, setNoAuth] = useState(false);
  const [corsRequired, setCorsRequired] = useState(false);

  const [result, setResult] = useState<RecommendResult | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const submit = async (text?: string) => {
    const value = (text ?? prompt).trim();
    if (value.length < 3) {
      toast.info('Describe what you are building', 'A sentence is enough.');
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const response = await api.post<RecommendResult>('/v1/recommend', {
        prompt: value,
        constraints: {
          ...(free ? { free: true } : {}),
          ...(noAuth ? { noAuth: true } : {}),
          ...(corsRequired ? { corsRequired: true } : {}),
        },
        limit: 6,
      });
      setResult(response.data);
    } catch (error) {
      toast.error(
        'Could not get recommendations',
        error instanceof ApiError ? error.userMessage : 'Please try again.',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles['wrap']}>
      <div className={styles['promptCard']}>
        <textarea
          className={styles['textarea']}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            // Cmd/Ctrl-Enter submits, matching the convention in chat tools;
            // plain Enter still inserts a newline for multi-line prompts.
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit();
          }}
          placeholder="Describe what you are building. For example: a travel app that needs flight schedules and hotel information, free tier preferred."
          aria-label="Describe your project"
        />

        <div className={styles['controls']}>
          <div className={styles['toggles']}>
            <button
              type="button"
              className={[styles['toggle'], free ? styles['toggleOn'] : ''].join(' ')}
              onClick={() => setFree((value) => !value)}
              aria-pressed={free}
            >
              <Icon name={free ? 'check' : 'plus'} size={12} />
              Free only
            </button>
            <button
              type="button"
              className={[styles['toggle'], noAuth ? styles['toggleOn'] : ''].join(' ')}
              onClick={() => setNoAuth((value) => !value)}
              aria-pressed={noAuth}
            >
              <Icon name={noAuth ? 'check' : 'plus'} size={12} />
              No API key
            </button>
            <button
              type="button"
              className={[styles['toggle'], corsRequired ? styles['toggleOn'] : ''].join(' ')}
              onClick={() => setCorsRequired((value) => !value)}
              aria-pressed={corsRequired}
            >
              <Icon name={corsRequired ? 'check' : 'plus'} size={12} />
              Browser friendly
            </button>
          </div>

          <Button onClick={() => void submit()} loading={loading}>
            <Icon name="sparkles" size={15} />
            Find APIs
          </Button>
        </div>
      </div>

      {!result && !loading ? (
        <div className={styles['examples']}>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className={styles['example']}
              onClick={() => {
                setPrompt(example);
                void submit(example);
              }}
            >
              {example}
            </button>
          ))}
        </div>
      ) : null}

      {loading ? (
        <div className={styles['results']}>
          <Skeleton height="72px" />
          <div style={{ height: 'var(--space-3)' }} />
          <Skeleton height="140px" />
          <div style={{ height: 'var(--space-3)' }} />
          <Skeleton height="140px" />
        </div>
      ) : null}

      {result ? (
        <div className={styles['results']}>
          {result.narrative ? <p className={styles['narrative']}>{result.narrative}</p> : null}

          {/*
            Showing what the system INFERRED is what makes this trustworthy: a
            user can see that "no auth" became a filter, and correct it if the
            inference was wrong.
          */}
          <div className={styles['interpreted']}>
            <span className={styles['interpretedLabel']}>Interpreted as:</span>
            {result.interpretedConstraints.categories.map((category) => (
              <Badge key={category} tone="accent">
                {category}
              </Badge>
            ))}
            {result.interpretedConstraints.free ? <Badge tone="up">free</Badge> : null}
            {result.interpretedConstraints.noAuth ? <Badge tone="up">no auth</Badge> : null}
            {result.interpretedConstraints.httpsOnly ? <Badge tone="info">https</Badge> : null}
            {result.interpretedConstraints.keywords.slice(0, 5).map((keyword) => (
              <Badge key={keyword} tone="neutral" mono>
                {keyword}
              </Badge>
            ))}
          </div>

          {result.recommendations.length === 0 ? (
            <p style={{ color: 'var(--text-muted)' }}>
              Nothing in the catalogue matches those constraints. Try relaxing a filter.
            </p>
          ) : (
            result.recommendations.map((recommendation, index) => (
              <article key={recommendation.api.id} className={styles['recommendation']}>
                <span
                  className={[styles['rank'], index === 0 ? styles['rankFirst'] : ''].join(' ')}
                  aria-hidden="true"
                >
                  {index + 1}
                </span>

                <div className={styles['recBody']}>
                  <div className={styles['recHead']}>
                    <Link href={`/apis/${recommendation.api.slug}`} className={styles['recName']}>
                      {recommendation.api.name}
                    </Link>
                    <StatusPill
                      status={recommendation.api.health.status}
                      latencyMs={recommendation.api.health.latencyMs}
                      compact
                    />
                    {recommendation.api.isFree ? <Badge tone="up">Free</Badge> : null}
                  </div>

                  <p className={styles['recDesc']}>{recommendation.api.description}</p>

                  <div className={styles['reasons']}>
                    {recommendation.reasons.map((reason) => (
                      <span key={reason} className={styles['reason']}>
                        <Icon name="check" size={13} strokeWidth={2.5} />
                        {reason}
                      </span>
                    ))}
                    {recommendation.caveats.map((caveat) => (
                      <span key={caveat} className={styles['caveat']}>
                        <Icon name="alert-triangle" size={13} />
                        {caveat}
                      </span>
                    ))}
                  </div>
                </div>
              </article>
            ))
          )}

          {/*
            Report 26.1: AI is an augmentation, not the source of truth. Being
            explicit about that is part of the product, not a disclaimer.
          */}
          <div className={styles['grounding']}>
            <Icon name="info" size={15} />
            <span>
              Every recommendation is derived from catalogue fields and live health data — nothing
              here is generated text about an API. Reasons and caveats are read off real columns, so
              they cannot be invented. Ranked in {result.tookMs}ms.
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
