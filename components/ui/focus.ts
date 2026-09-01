'use client';
/**
 * Focus utilities — one implementation of overlay focus behaviour, used by Modal,
 * Drawer, ConfirmationDialog and the mobile navigation. Nothing else re-implements
 * focus handling; that is how the behaviour stays consistent and testable.
 *
 * What "trapped" means here:
 *   - focus moves into the surface when it opens, to the first focusable element
 *     (or the surface itself as a fallback);
 *   - Tab and Shift+Tab cycle inside the surface and never leave it;
 *   - Escape closes it;
 *   - the page behind stops scrolling while it is open;
 *   - focus returns to the element that opened it when it closes.
 */
import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * The stack of open, trapped surfaces — innermost last.
 *
 * Every trap listens on `document` in the CAPTURE phase, so without this they all fire
 * in mount order: pressing Escape inside a dialog opened FROM a drawer ran the drawer's
 * handler first, closed the drawer, and stopped propagation — leaving the dialog behind
 * with nothing underneath it. Only the topmost surface responds to Escape and Tab; the
 * ones below it wait their turn, which is what "modal" has always meant.
 */
const TRAP_STACK: Array<HTMLElement> = [];

export interface FocusTrapOptions {
  /** Called on Escape and when the scrim is the click target. Required — a trap without an exit is a cage. */
  onClose: () => void;
  /** Lock body scroll while active (default true). */
  lockScroll?: boolean;
}

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  { onClose, lockScroll = true }: FocusTrapOptions,
): void {
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const surface = ref.current;
    if (!surface) return;

    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    TRAP_STACK.push(surface);

    const focusables = (): HTMLElement[] =>
      Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Into the surface. The surface itself is the fallback so focus never stays behind.
    const first = focusables()[0];
    if (first) first.focus();
    else { surface.tabIndex = -1; surface.focus(); }

    const onKeyDown = (event: KeyboardEvent) => {
      // Only the innermost open surface reacts. See TRAP_STACK.
      if (TRAP_STACK[TRAP_STACK.length - 1] !== surface) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) { event.preventDefault(); return; }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const current = document.activeElement;
      if (event.shiftKey && (current === firstItem || !surface.contains(current))) {
        event.preventDefault(); lastItem.focus();
      } else if (!event.shiftKey && current === lastItem) {
        event.preventDefault(); firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    let previousOverflow = '';
    if (lockScroll) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const at = TRAP_STACK.lastIndexOf(surface);
      if (at !== -1) TRAP_STACK.splice(at, 1);
      /*
       * Scroll stays locked while ANY surface is still open. Restoring the outer
       * drawer's "" here would unlock the page behind a dialog that is still up.
       */
      if (lockScroll && TRAP_STACK.length === 0) document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus?.();
    };
  }, [ref, active, onClose, lockScroll]);
}

/**
 * Mark everything OUTSIDE an open overlay inert for assistive tech and the tab order.
 * Used by the mobile navigation: the closed-over content must not be tabbable behind
 * the scrim. Applies `inert` to the given elements while active.
 */
export function useInertOutside(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  /**
   * Elements that must stay interactive even though they sit outside the surface — the
   * scrim above all. Marking the scrim inert makes a labelled "Close navigation" control
   * that swallows every tap, which leaves a touch user with no way out of the drawer at
   * all (Escape needs a hardware keyboard). Anything carrying `data-inert-exempt` is
   * skipped too, so a caller can opt an element out without threading a ref.
   */
  exempt: ReadonlyArray<RefObject<HTMLElement | null>> = [],
): void {
  useEffect(() => {
    if (!active) return;
    const keep = ref.current;
    if (!keep || !keep.parentElement) return;
    const spared = new Set(exempt.map((r) => r.current).filter(Boolean));
    const siblings = Array.from(keep.parentElement.children)
      .filter((el): el is HTMLElement => el instanceof HTMLElement
        && el !== keep
        && !spared.has(el)
        && !el.hasAttribute('data-inert-exempt'));
    for (const el of siblings) el.setAttribute('inert', '');
    return () => { for (const el of siblings) el.removeAttribute('inert'); };
    // `exempt` is a fresh array each render; its CONTENTS are refs with stable identity,
    // so depending on the array would re-run this effect forever. active/ref is the gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, active]);
}
