'use client';

import type { Collection } from '@apihub/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { useSession } from '@/features/auth/SessionProvider';
import { ApiError, api } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/format';

import styles from './CollectionsManager.module.css';

export function CollectionsManager({ initial }: { initial: Collection[] }) {
  const [collections, setCollections] = useState(initial);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const { csrfToken } = useSession();
  const toast = useToast();
  const router = useRouter();

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;

    setSubmitting(true);
    try {
      const result = await api.post<Collection>(
        '/v1/me/collections',
        { name: name.trim(), description: description.trim() || undefined, isPublic },
        { csrfToken: csrfToken ?? undefined },
      );

      setCollections((current) => [result.data, ...current]);
      setName('');
      setDescription('');
      setIsPublic(false);
      setCreating(false);
      toast.success('Collection created');
      router.refresh();
    } catch (error) {
      toast.error(
        'Could not create collection',
        error instanceof ApiError ? error.userMessage : 'Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (collection: Collection) => {
    // Deletion is irreversible, so it is confirmed rather than instant.
    if (!window.confirm(`Delete "${collection.name}"? This cannot be undone.`)) return;

    // Optimistic removal; restored if the request fails.
    const previous = collections;
    setCollections((current) => current.filter((entry) => entry.id !== collection.id));

    try {
      await api.delete(`/v1/me/collections/${collection.id}`, {
        csrfToken: csrfToken ?? undefined,
      });
      toast.success('Collection deleted');
      router.refresh();
    } catch (error) {
      setCollections(previous);
      toast.error(
        'Could not delete collection',
        error instanceof ApiError ? error.userMessage : 'Please try again.',
      );
    }
  };

  return (
    <>
      <div className={styles['toolbar']}>
        <p className={styles['count']}>
          {collections.length} {collections.length === 1 ? 'collection' : 'collections'}
        </p>
        <Button onClick={() => setCreating((open) => !open)}>
          <Icon name={creating ? 'x' : 'plus'} size={15} />
          {creating ? 'Cancel' : 'New collection'}
        </Button>
      </div>

      {creating ? (
        <Card className={styles['createCard']}>
          <CardBody>
            <form onSubmit={create}>
              <div className={styles['field']}>
                <label className={styles['label']} htmlFor="collection-name">
                  Name
                </label>
                <input
                  id="collection-name"
                  className={styles['input']}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="My ecommerce stack"
                  maxLength={80}
                  required
                  autoFocus
                />
              </div>

              <div className={styles['field']}>
                <label className={styles['label']} htmlFor="collection-description">
                  Description <span className={styles['optional']}>(optional)</span>
                </label>
                <input
                  id="collection-description"
                  className={styles['input']}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Payments, email and shipping for the storefront"
                  maxLength={500}
                />
              </div>

              <label className={styles['checkbox']}>
                <input
                  type="checkbox"
                  checked={isPublic}
                  onChange={(event) => setIsPublic(event.target.checked)}
                />
                <span>
                  Make public
                  <span className={styles['checkboxHint']}>
                    Anyone with the link can view it. Private collections are visible only to you.
                  </span>
                </span>
              </label>

              <Button type="submit" loading={submitting}>
                Create collection
              </Button>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {collections.length === 0 && !creating ? (
        <div className={styles['empty']}>
          <span className={styles['emptyIcon']}>
            <Icon name="folder" size={22} />
          </span>
          <h2 className={styles['emptyTitle']}>No collections yet</h2>
          <p className={styles['emptyText']}>
            Collections group APIs by project. Build one for each thing you are working on, then
            share it with a link or keep it private.
          </p>
          <Button onClick={() => setCreating(true)}>
            <Icon name="plus" size={15} />
            Create your first collection
          </Button>
        </div>
      ) : (
        <div className={styles['grid']}>
          {collections.map((collection) => (
            <Card key={collection.id} interactive>
              <CardHeader
                title={
                  <Link href={`/collections/${collection.id}`} className={styles['cardLink']}>
                    {collection.name}
                  </Link>
                }
                subtitle={`${collection.itemCount} ${
                  collection.itemCount === 1 ? 'API' : 'APIs'
                } · updated ${formatRelativeTime(collection.updatedAt)}`}
                action={
                  <span className={styles['cardActions']}>
                    <span
                      className={styles['visibility']}
                      title={collection.isPublic ? 'Public' : 'Private'}
                    >
                      <Icon name={collection.isPublic ? 'globe' : 'lock'} size={13} />
                    </span>
                    <button
                      type="button"
                      className={styles['delete']}
                      onClick={() => void remove(collection)}
                      aria-label={`Delete ${collection.name}`}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </span>
                }
              />
              {collection.description ? (
                <CardBody tight>
                  <p className={styles['description']}>{collection.description}</p>
                </CardBody>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
