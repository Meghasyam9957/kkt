/**
 * Composition primitives (§4) — rhythm comes from a declared gap on the container,
 * never from spacer <div>s between siblings. Gaps are spacing tokens; passing a raw
 * pixel number is deliberately not possible.
 *
 * Server-safe: no state, no handlers, no client runtime.
 */
import type { CSSProperties, HTMLAttributes } from 'react';

type SpaceToken = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const gapVar = (token: SpaceToken) => `var(--s-${token})`;

/** Vertical flow: children stacked with one declared gap. */
export function Stack({ gap = 4, className = '', style, children, ...rest }:
  HTMLAttributes<HTMLDivElement> & { gap?: SpaceToken }) {
  return (
    <div
      className={`sv-stack ${className}`}
      style={{ ...style, '--stack-gap': gapVar(gap) } as CSSProperties}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Inline wrap: labels-with-controls, pill groups, masthead clusters. */
export function Cluster({ gap = 3, className = '', style, children, ...rest }:
  HTMLAttributes<HTMLDivElement> & { gap?: SpaceToken }) {
  return (
    <div
      className={`sv-cluster ${className}`}
      style={{ ...style, '--cluster-gap': gapVar(gap) } as CSSProperties}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Responsive columns: as many `min`-wide tracks as fit, no media query needed. */
export function Grid({ gap = 4, min = '16rem', className = '', style, children, ...rest }:
  HTMLAttributes<HTMLDivElement> & { gap?: SpaceToken; min?: string }) {
  return (
    <div
      className={`sv-grid ${className}`}
      style={{ ...style, '--grid-gap': gapVar(gap), '--grid-min': min } as CSSProperties}
      {...rest}
    >
      {children}
    </div>
  );
}
