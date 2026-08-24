'use client';
/**
 * DATA BOUNDARY — one place where loading, empty and error are decided.
 *
 * Every data block on every page goes through this, so no screen can accidentally render
 * a blank white box while it waits, or a silent nothing when a fetch fails.
 */
import type { ReactNode } from 'react';
import { LoadingBlock, EmptyState, ErrorState } from '@/components/ui/primitives';

export interface DataBoundaryProps<T> {
  loading?: boolean;
  error?: string | null;
  data: T | null | undefined;
  /** Called with the data when it is present and non-empty. */
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyMessage?: string;
  loadingRows?: number;
  loadingLabel?: string;
  onRetry?: () => void;
}

export function DataBoundary<T>({
  loading = false, error = null, data, children,
  isEmpty = defaultIsEmpty,
  emptyTitle = 'Nothing to show',
  emptyMessage = 'There is no data for this period or filter.',
  loadingRows = 3, loadingLabel = 'Loading data', onRetry,
}: DataBoundaryProps<T>) {
  if (error) return <ErrorState message={error} {...(onRetry ? { onRetry } : {})} />;
  if (loading) return <LoadingBlock rows={loadingRows} label={loadingLabel} />;
  if (data === null || data === undefined) {
    return <ErrorState message="No data was returned for this section." {...(onRetry ? { onRetry } : {})} />;
  }
  if (isEmpty(data)) return <EmptyState title={emptyTitle} message={emptyMessage} />;
  return <>{children(data)}</>;
}

function defaultIsEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
