'use client';
/**
 * FILTER BAR — the single filter implementation.
 *
 * One component, used by every page, so filter behaviour cannot drift between screens.
 * Each control is a native <select>: keyboard and screen-reader support come free, and on
 * mobile the platform's own picker is better than anything custom.
 */
import { useFilters } from './FilterContext';
import { formatMonthLong, propertyOptionLabel } from '@/lib/shared/format';

export function FilterBar({ show = ['month', 'property', 'platform'] }: {
  show?: Array<'month' | 'property' | 'platform'>;
}) {
  const {
    filters, availableMonths, availableProperties, availablePlatforms,
    setMonth, setProperty, setPlatform, reset, isFiltered,
  } = useFilters();

  return (
    <div className="sv-filters" role="group" aria-label="Report filters">
      {show.includes('month') ? (
        <label className="sv-filter">
          <span className="sv-filter__label">Reporting month</span>
          <select
            className="sv-filter__select"
            value={filters.month}
            onChange={(e) => setMonth(e.target.value)}
          >
            {availableMonths.map((month) => (
              <option key={month} value={month}>{formatMonthLong(month)}</option>
            ))}
          </select>
        </label>
      ) : null}

      {show.includes('property') ? (
        <label className="sv-filter">
          <span className="sv-filter__label">Property</span>
          <select
            className="sv-filter__select"
            value={filters.propertyId ?? ''}
            onChange={(e) => setProperty(e.target.value || null)}
          >
            <option value="">All properties</option>
            {availableProperties.map((option) => (
              <option key={option.id} value={option.id}>{propertyOptionLabel(option)}</option>
            ))}
          </select>
        </label>
      ) : null}

      {show.includes('platform') ? (
        <label className="sv-filter">
          <span className="sv-filter__label">Platform</span>
          <select
            className="sv-filter__select"
            value={filters.platform ?? ''}
            onChange={(e) => setPlatform(e.target.value || null)}
          >
            <option value="">All platforms</option>
            {availablePlatforms.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      ) : null}

      {isFiltered ? (
        <button type="button" className="sv-filter__reset" onClick={reset}>
          Reset filters
        </button>
      ) : null}
    </div>
  );
}
