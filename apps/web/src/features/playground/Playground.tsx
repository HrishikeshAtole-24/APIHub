'use client';

import type { HttpMethod, PlaygroundResponse } from '@apihub/contracts';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { ApiError, api } from '@/lib/api-client';
import { useCopyToClipboard } from '@/lib/hooks';
import { formatBytes } from '@/lib/format';

import styles from './Playground.module.css';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

interface KeyValue {
  id: number;
  name: string;
  value: string;
  enabled: boolean;
}

type AuthMode = 'none' | 'bearer' | 'apiKey' | 'basic';
type RequestTab = 'params' | 'headers' | 'auth' | 'body';
type ResponseTab = 'body' | 'headers';

let nextId = 1;
const newRow = (): KeyValue => ({ id: nextId++, name: '', value: '', enabled: true });

export function Playground({
  initialUrl = '',
  apiId,
}: {
  initialUrl?: string;
  apiId?: string;
}) {
  const [method, setMethod] = useState<HttpMethod>('GET');
  const [url, setUrl] = useState(initialUrl);
  const [params, setParams] = useState<KeyValue[]>([newRow()]);
  const [headers, setHeaders] = useState<KeyValue[]>([newRow()]);
  const [body, setBody] = useState('');
  const [contentType, setContentType] = useState('application/json');

  const [authMode, setAuthMode] = useState<AuthMode>('none');
  const [token, setToken] = useState('');
  const [keyName, setKeyName] = useState('X-API-Key');
  const [keyIn, setKeyIn] = useState<'header' | 'query'>('header');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [requestTab, setRequestTab] = useState<RequestTab>('params');
  const [responseTab, setResponseTab] = useState<ResponseTab>('body');

  const [response, setResponse] = useState<PlaygroundResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [sending, setSending] = useState(false);

  const toast = useToast();
  const { copied, copy } = useCopyToClipboard();

  const activeParams = params.filter((row) => row.name.trim() && row.enabled).length;
  const activeHeaders = headers.filter((row) => row.name.trim() && row.enabled).length;

  const send = async () => {
    if (!url.trim()) {
      toast.error('Enter a URL first');
      return;
    }

    setSending(true);
    setError(null);
    setResponse(null);

    try {
      const result = await api.post<PlaygroundResponse>('/v1/playground/requests', {
        method,
        url: url.trim(),
        headers: headers
          .filter((row) => row.name.trim())
          .map((row) => ({ name: row.name.trim(), value: row.value, enabled: row.enabled })),
        queryParams: params
          .filter((row) => row.name.trim())
          .map((row) => ({ name: row.name.trim(), value: row.value, enabled: row.enabled })),
        ...(method !== 'GET' && method !== 'HEAD' && body ? { body, contentType } : {}),
        auth: buildAuth(),
        ...(apiId ? { apiId } : {}),
      });

      setResponse(result.data);
      setResponseTab('body');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught);
        // Blocked targets are a security decision, not a failure: surface the
        // reason clearly rather than as a generic error toast.
        if (caught.code === 'BLOCKED_TARGET') {
          toast.error('Request blocked', caught.message);
        } else {
          toast.error('Request failed', caught.userMessage);
        }
      } else {
        toast.error('Request failed', 'An unexpected error occurred.');
      }
    } finally {
      setSending(false);
    }
  };

  function buildAuth() {
    switch (authMode) {
      case 'bearer':
        return { type: 'bearer' as const, token };
      case 'apiKey':
        return { type: 'apiKey' as const, key: token, in: keyIn, name: keyName };
      case 'basic':
        return { type: 'basic' as const, username, password };
      default:
        return { type: 'none' as const };
    }
  }

  const statusClass = (status: number): string => {
    if (status < 300) return styles['status2xx'] as string;
    if (status < 400) return styles['status3xx'] as string;
    if (status < 500) return styles['status4xx'] as string;
    return styles['status5xx'] as string;
  };

  /** Pretty-print JSON when the body actually parses; otherwise show it raw. */
  const formattedBody = (() => {
    if (!response) return '';
    const type = response.contentType ?? '';
    if (!type.includes('json')) return response.body;
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      return response.body;
    }
  })();

  return (
    <div className={styles['layout']}>
      {/* ── Request ─────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Request" bordered />

        <div style={{ padding: 'var(--space-4)' }}>
          <div className={styles['urlBar']}>
            <select
              className={styles['methodSelect']}
              value={method}
              onChange={(event) => setMethod(event.target.value as HttpMethod)}
              aria-label="HTTP method"
            >
              {METHODS.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>

            <input
              className={styles['urlInput']}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void send();
              }}
              placeholder="https://api.example.com/endpoint"
              aria-label="Request URL"
              spellCheck={false}
              autoComplete="off"
            />

            <Button onClick={() => void send()} loading={sending}>
              <Icon name="send" size={14} />
              Send
            </Button>
          </div>

          <div className={styles['tabs']} role="tablist">
            {(
              [
                ['params', 'Params', activeParams],
                ['headers', 'Headers', activeHeaders],
                ['auth', 'Auth', authMode !== 'none' ? 1 : 0],
                ['body', 'Body', body ? 1 : 0],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={requestTab === key}
                className={[styles['tab'], requestTab === key ? styles['tabActive'] : ''].join(' ')}
                onClick={() => setRequestTab(key)}
              >
                {label}
                {count > 0 ? <span className={styles['tabCount']}>{count}</span> : null}
              </button>
            ))}
          </div>

          {requestTab === 'params' ? (
            <KeyValueEditor rows={params} onChange={setParams} placeholder="parameter" />
          ) : null}

          {requestTab === 'headers' ? (
            <KeyValueEditor rows={headers} onChange={setHeaders} placeholder="header" />
          ) : null}

          {requestTab === 'auth' ? (
            <div>
              <div className={styles['field']}>
                <label className={styles['label']} htmlFor="auth-mode">
                  Authentication
                </label>
                <select
                  id="auth-mode"
                  className={styles['select']}
                  value={authMode}
                  onChange={(event) => setAuthMode(event.target.value as AuthMode)}
                >
                  <option value="none">No auth</option>
                  <option value="bearer">Bearer token</option>
                  <option value="apiKey">API key</option>
                  <option value="basic">Basic auth</option>
                </select>
              </div>

              {authMode === 'bearer' || authMode === 'apiKey' ? (
                <>
                  {authMode === 'apiKey' ? (
                    <>
                      <div className={styles['field']}>
                        <label className={styles['label']} htmlFor="key-name">
                          Key name
                        </label>
                        <input
                          id="key-name"
                          className={styles['input']}
                          value={keyName}
                          onChange={(event) => setKeyName(event.target.value)}
                        />
                      </div>
                      <div className={styles['field']}>
                        <label className={styles['label']} htmlFor="key-in">
                          Send in
                        </label>
                        <select
                          id="key-in"
                          className={styles['select']}
                          value={keyIn}
                          onChange={(event) => setKeyIn(event.target.value as 'header' | 'query')}
                        >
                          <option value="header">Header</option>
                          <option value="query">Query string</option>
                        </select>
                      </div>
                    </>
                  ) : null}

                  <div className={styles['field']}>
                    <label className={styles['label']} htmlFor="token">
                      {authMode === 'bearer' ? 'Token' : 'Key'}
                    </label>
                    <input
                      id="token"
                      className={styles['input']}
                      type="password"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      placeholder="Paste your credential"
                      autoComplete="off"
                    />
                  </div>
                </>
              ) : null}

              {authMode === 'basic' ? (
                <>
                  <div className={styles['field']}>
                    <label className={styles['label']} htmlFor="username">
                      Username
                    </label>
                    <input
                      id="username"
                      className={styles['input']}
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <div className={styles['field']}>
                    <label className={styles['label']} htmlFor="password">
                      Password
                    </label>
                    <input
                      id="password"
                      className={styles['input']}
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="off"
                    />
                  </div>
                </>
              ) : null}

              {/*
                Credential handling is stated plainly. A user pasting a real key
                into a hosted tool deserves to know what happens to it.
              */}
              <p className={styles['hint']}>
                <Icon name="lock" size={12} /> Credentials are used for this single request and are
                never stored. They are stripped from logs and from generated code.
              </p>
            </div>
          ) : null}

          {requestTab === 'body' ? (
            <div>
              <div className={styles['field']}>
                <label className={styles['label']} htmlFor="content-type">
                  Content type
                </label>
                <select
                  id="content-type"
                  className={styles['select']}
                  value={contentType}
                  onChange={(event) => setContentType(event.target.value)}
                >
                  <option value="application/json">application/json</option>
                  <option value="application/x-www-form-urlencoded">
                    application/x-www-form-urlencoded
                  </option>
                  <option value="text/plain">text/plain</option>
                </select>
              </div>

              <div className={styles['field']}>
                <label className={styles['label']} htmlFor="body">
                  Body
                </label>
                <textarea
                  id="body"
                  className={styles['textarea']}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder={'{\n  "key": "value"\n}'}
                  spellCheck={false}
                />
              </div>

              {method === 'GET' || method === 'HEAD' ? (
                <p className={styles['hint']}>
                  A body is not sent with {method} requests.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      {/* ── Response ────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Response"
          action={
            response ? (
              <Button size="sm" variant="ghost" onClick={() => void copy(formattedBody)}>
                <Icon name={copied ? 'check' : 'copy'} size={13} />
                {copied ? 'Copied' : 'Copy'}
              </Button>
            ) : undefined
          }
          bordered
        />

        {error ? (
          <div className={styles['errorBox']}>
            <div className={styles['errorTitle']}>
              <Icon name="alert-circle" size={15} />
              {error.code === 'BLOCKED_TARGET' ? 'Blocked by the security guard' : 'Request failed'}
            </div>
            <p className={styles['errorText']}>{error.message}</p>
            <p className={styles['errorCode']}>
              {error.code}
              {error.requestId ? ` · ${error.requestId}` : ''}
            </p>
          </div>
        ) : null}

        {!response && !error ? (
          <div className={styles['placeholder']}>
            <span className={styles['placeholderIcon']}>
              <Icon name="send" size={19} />
            </span>
            <p style={{ fontSize: 'var(--text-sm)' }}>
              Send a request to see the response here.
            </p>
          </div>
        ) : null}

        {response ? (
          <>
            <div className={styles['responseHead']}>
              <span className={`${styles['statusCode']} ${statusClass(response.status)}`}>
                {response.status} {response.statusText}
              </span>

              <span className={styles['responseMeta']}>
                <span className={styles['metaItem']}>
                  <Icon name="clock" size={12} />
                  {Math.round(response.timing.totalMs)}ms
                </span>
                <span className={styles['metaItem']}>
                  <Icon name="download" size={12} />
                  {formatBytes(response.bodySizeBytes)}
                </span>
              </span>
            </div>

            {response.truncated ? (
              <p className={styles['hint']} style={{ padding: 'var(--space-3) var(--space-4) 0' }}>
                <Icon name="info" size={12} /> Response truncated at the size limit.
              </p>
            ) : null}

            {response.redirects.length > 0 ? (
              <p className={styles['hint']} style={{ padding: 'var(--space-3) var(--space-4) 0' }}>
                <Icon name="link" size={12} /> Followed {response.redirects.length} redirect
                {response.redirects.length === 1 ? '' : 's'}; each one was re-validated.
              </p>
            ) : null}

            <div className={styles['tabs']} style={{ margin: 'var(--space-4) var(--space-4) 0' }}>
              {(
                [
                  ['body', 'Body'],
                  ['headers', `Headers (${Object.keys(response.headers).length})`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={[styles['tab'], responseTab === key ? styles['tabActive'] : ''].join(
                    ' ',
                  )}
                  onClick={() => setResponseTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {responseTab === 'body' ? (
              // Rendered as text inside <pre>, never as HTML: this is an
              // untrusted upstream response (report 20.1).
              <pre className={styles['responseBody']}>{formattedBody}</pre>
            ) : (
              <table className={styles['headerTable']}>
                <tbody>
                  {Object.entries(response.headers).map(([name, value]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : null}
      </Card>
    </div>
  );
}

/** Editable list of enabled/disabled name-value pairs. */
function KeyValueEditor({
  rows,
  onChange,
  placeholder,
}: {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  placeholder: string;
}) {
  const update = (id: number, patch: Partial<KeyValue>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  return (
    <div>
      {rows.map((row) => (
        <div key={row.id} className={styles['kvRow']}>
          <button
            type="button"
            className={[styles['kvToggle'], row.enabled ? styles['kvToggleOn'] : ''].join(' ')}
            onClick={() => update(row.id, { enabled: !row.enabled })}
            aria-label={row.enabled ? `Disable ${placeholder}` : `Enable ${placeholder}`}
          >
            <Icon name="check" size={10} strokeWidth={3} />
          </button>

          <input
            className={styles['kvInput']}
            value={row.name}
            onChange={(event) => update(row.id, { name: event.target.value })}
            placeholder={`${placeholder} name`}
            spellCheck={false}
            aria-label={`${placeholder} name`}
          />
          <input
            className={styles['kvInput']}
            value={row.value}
            onChange={(event) => update(row.id, { value: event.target.value })}
            placeholder="value"
            spellCheck={false}
            aria-label={`${placeholder} value`}
          />

          <button
            type="button"
            className={styles['kvRemove']}
            onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))}
            aria-label={`Remove ${placeholder}`}
            // Keep at least one row so the editor never becomes an empty void.
            disabled={rows.length === 1}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}

      <Button
        size="sm"
        variant="ghost"
        className={styles['addRow']}
        onClick={() => onChange([...rows, newRow()])}
      >
        <Icon name="plus" size={13} />
        Add {placeholder}
      </Button>
    </div>
  );
}
