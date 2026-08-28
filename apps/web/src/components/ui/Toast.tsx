'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Icon, type IconName } from './Icon';

import styles from './Toast.module.css';

export type ToastVariant = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  variant: ToastVariant;
  title: string;
  description?: string;
}

interface ToastContextValue {
  toast: (input: Omit<Toast, 'id'>) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS: Record<ToastVariant, IconName> = {
  success: 'check-circle',
  error: 'alert-circle',
  info: 'info',
};

/** Errors stay longer: they usually carry something the user must read. */
const DURATION: Record<ToastVariant, number> = {
  success: 3200,
  info: 4000,
  error: 6000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (input: Omit<Toast, 'id'>) => {
      const id = nextId.current;
      nextId.current += 1;

      // Cap the stack: more than a few at once is noise, and the oldest is
      // the least relevant.
      setToasts((current) => [...current, { ...input, id }].slice(-4));

      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DURATION[input.variant]),
      );
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (title, description) => toast({ variant: 'success', title, description }),
      error: (title, description) => toast({ variant: 'error', title, description }),
      info: (title, description) => toast({ variant: 'info', title, description }),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/*
        `role="status"` with aria-live="polite" announces the toast to screen
        readers without interrupting whatever they are currently reading.
      */}
      <div className={styles['viewport']} role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((entry) => (
          <div key={entry.id} className={`${styles['toast']} ${styles[entry.variant]}`}>
            <span className={styles['iconWrap']}>
              <Icon name={ICONS[entry.variant]} size={17} />
            </span>

            <div className={styles['content']}>
              <div className={styles['title']}>{entry.title}</div>
              {entry.description ? (
                <div className={styles['description']}>{entry.description}</div>
              ) : null}
            </div>

            <button
              type="button"
              className={styles['close']}
              onClick={() => dismiss(entry.id)}
              aria-label="Dismiss notification"
            >
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
