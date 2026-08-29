'use client';
/**
 * REPORT FILTER STATE — month, property, platform.
 *
 * Deliberately client/session state held in the URL query string. It is NEVER written to
 * the workbook: `CFG_REPORT_MONTH` is one shared mutable cell, so two users viewing
 * different months would corrupt each other's reads and silently change what the
 * spreadsheet dashboard shows the operator (Decision D1).
 *
 * The URL is the store, which gives shareable links, working browser history and correct
 * behaviour across tabs for free. The same filter shape is what the server-side analytics
 * layer already accepts, so nothing changes when live data arrives.
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReportFilters, PropertyOption } from '@/lib/data/providers/types';

interface FilterContextValue {
  filters: ReportFilters;
  availableMonths: string[];
  availableProperties: PropertyOption[];
  availablePlatforms: string[];
  setMonth(month: string): void;
  setProperty(propertyId: string | null): void;
  setPlatform(platform: string | null): void;
  reset(): void;
  isFiltered: boolean;
}

const FilterCtx = createContext<FilterContextValue | null>(null);

export function FilterProvider({
  children, defaultMonth, availableMonths, availableProperties, availablePlatforms,
}: {
  children: ReactNode;
  defaultMonth: string;
  availableMonths: string[];
  availableProperties: PropertyOption[];
  availablePlatforms: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filters = useMemo<ReportFilters>(() => {
    const month = searchParams.get('month');
    return {
      month: month && availableMonths.includes(month) ? month : defaultMonth,
      propertyId: searchParams.get('property'),
      platform: searchParams.get('platform'),
    };
  }, [searchParams, defaultMonth, availableMonths]);

  const apply = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    // `scroll: false` keeps the reader's place when they change a filter.
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [router, pathname, searchParams]);

  const value = useMemo<FilterContextValue>(() => ({
    filters,
    availableMonths,
    availableProperties,
    availablePlatforms,
    setMonth: (month) => apply({ month }),
    setProperty: (propertyId) => apply({ property: propertyId }),
    setPlatform: (platform) => apply({ platform }),
    reset: () => apply({ month: null, property: null, platform: null }),
    isFiltered: Boolean(searchParams.get('property') || searchParams.get('platform')
      || (searchParams.get('month') && searchParams.get('month') !== defaultMonth)),
  }), [filters, availableMonths, availableProperties, availablePlatforms, apply, searchParams, defaultMonth]);

  return <FilterCtx.Provider value={value}>{children}</FilterCtx.Provider>;
}

export function useFilters(): FilterContextValue {
  const ctx = useContext(FilterCtx);
  if (!ctx) throw new Error('useFilters must be used inside a FilterProvider');
  return ctx;
}
