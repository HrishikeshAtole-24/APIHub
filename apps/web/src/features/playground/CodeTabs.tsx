'use client';

import type { AuthType, CodeGenResult, CodeLanguage } from '@apihub/contracts';
import { CODE_LANGUAGE_LABELS } from '@apihub/contracts';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { api } from '@/lib/api-client';
import { useCopyToClipboard } from '@/lib/hooks';

import styles from './CodeTabs.module.css';

const LANGUAGES: CodeLanguage[] = [
  'curl',
  'javascript-fetch',
  'typescript-fetch',
  'python-requests',
  'go',
  'java',
  'csharp',
  'php',
  'ruby',
  'rust',
];

/**
 * Integration snippets for an API.
 *
 * Generation happens server-side so the browser and the server can never
 * disagree about what the code should be, and so the escaping rules for ten
 * languages live in one tested place rather than in the UI.
 */
export function CodeTabs({
  url,
  apiId,
  authType,
}: {
  url: string;
  apiId?: string;
  authType?: AuthType;
}) {
  const [language, setLanguage] = useState<CodeLanguage>('curl');
  const [code, setCode] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    api
      .post<CodeGenResult>('/v1/playground/code', {
        language,
        request: {
          method: 'GET',
          url: url || 'https://api.example.com/endpoint',
          headers: [],
          queryParams: [],
          // Mirror the API's real auth model so the snippet shows the right
          // credential placement rather than a generic example.
          auth:
            authType === 'apiKey'
              ? { type: 'apiKey', key: 'placeholder', in: 'header', name: 'X-API-Key' }
              : authType === 'bearer' || authType === 'oauth2' || authType === 'jwt'
                ? { type: 'bearer', token: 'placeholder' }
                : { type: 'none' },
          ...(apiId ? { apiId } : {}),
        },
      })
      .then((result) => {
        if (!cancelled) setCode(result.data.code);
      })
      .catch(() => {
        if (!cancelled) setCode('// Could not generate a snippet right now.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [language, url, apiId, authType]);

  return (
    <div className={styles['wrap']}>
      <div className={styles['tabs']} role="tablist" aria-label="Language">
        {LANGUAGES.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={entry === language}
            className={[styles['tab'], entry === language ? styles['tabActive'] : ''].join(' ')}
            onClick={() => setLanguage(entry)}
          >
            {CODE_LANGUAGE_LABELS[entry]}
          </button>
        ))}
      </div>

      <div className={styles['body']}>
        <Button
          size="sm"
          variant="secondary"
          className={styles['copy']}
          onClick={() => void copy(code)}
          disabled={loading}
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          {copied ? 'Copied' : 'Copy'}
        </Button>

        {loading ? (
          <p className={styles['loading']}>Generating…</p>
        ) : (
          <pre className={styles['pre']}>
            <code>{code}</code>
          </pre>
        )}
      </div>

      <p className={styles['note']}>
        <Icon name="shield" size={13} />
        Credentials are read from an environment variable, never written into the snippet.
      </p>
    </div>
  );
}
