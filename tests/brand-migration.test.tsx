/**
 * MAKAM BRAND MIGRATION.
 *
 * The product was Srivillu; it is MAKAM. These tests hold two lines at once:
 *
 *   1. Everything a person can SEE says MAKAM — the shell, sign-in, page titles, the
 *      accessible name of the logo, the copilot.
 *   2. Nothing INTERNAL was renamed to chase the logo. The `sv-` class prefix, the
 *      contract identifiers, the environment variables and the historical phase reports
 *      all stay, because renaming them buys a user nothing and breaks pinned selectors.
 *
 * The single source is BRAND in lib/shared/brand.ts: every visible name derives from it,
 * so these assertions fail if someone hardcodes a brand string somewhere instead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import fs from 'node:fs';
import path from 'node:path';

import {
  AppRouterContext, type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import { BRAND, BRAND_ASSET_SPECS, type BrandAssetSet } from '@/lib/shared/brand';
import { MakamLogo, MakamMark } from '@/components/shell/Logo';
import { AppShell } from '@/components/shell/AppShell';
import { NAVIGATION } from '@/lib/shared/navigation';
import { ENVIRONMENT_DESCRIPTORS, type PublicEnvironmentInfo } from '@/lib/shared/environment';
import type { DataMeta } from '@/lib/data/providers/types';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const inertRouter = {
  push: () => {}, replace: () => {}, refresh: () => {},
  back: () => {}, forward: () => {}, prefetch: () => {},
} as unknown as AppRouterInstance;

const DEMO_ENVIRONMENT: PublicEnvironmentInfo = {
  ...ENVIRONMENT_DESCRIPTORS.demo, dataSourceLabel: 'Demo Workbook', fixtures: true,
};
const META: DataMeta = {
  source: 'FIXTURE', asOf: new Date().toISOString(), period: '2027-01',
  freshness: 'GOOD', demo: true,
};

function renderShell(role: 'ADMIN' | 'OPERATIONS' | 'INVESTOR', pathname: string) {
  return render(
    createElement(AppRouterContext.Provider, { value: inertRouter },
      createElement(PathnameContext.Provider, { value: pathname },
        createElement(AppShell, {
          user: { name: 'Demo Person', email: 'demo@makam.test', role },
          meta: META, environment: DEMO_ENVIRONMENT, alertCount: 0,
          children: createElement('p', null, 'content'),
        }))),
  );
}

beforeEach(() => cleanup());

/* ================================================================== *
 * 1 · One source for the name
 * ================================================================== */

describe('brand · the name has a single source', () => {
  it('BRAND carries MAKAM and nothing carries the old brand', () => {
    expect(BRAND.shortName).toBe('MAKAM');
    expect(BRAND.wordmark).toBe('MAKAM');
    expect(BRAND.name).toContain('MAKAM');
    expect(JSON.stringify(BRAND)).not.toMatch(/srivillu/i);
  });

  it('the asset contract points at MAKAM artwork', () => {
    for (const candidate of BRAND_ASSET_SPECS.logo.candidates) expect(candidate).toContain('makam');
    for (const candidate of BRAND_ASSET_SPECS.mark.candidates) expect(candidate).toContain('makam');
  });
});

/* ================================================================== *
 * 2 · What a person sees
 * ================================================================== */

describe('brand · the visible product says MAKAM', () => {
  it('the lockup shows the wordmark, and names itself for a screen reader', () => {
    const { container } = render(createElement(MakamLogo));
    expect(container.querySelector('.sv-logo__word')?.textContent).toBe('MAKAM');
    // The placeholder mark speaks the product name; the logo is never the only context.
    expect(screen.getByRole('img', { name: BRAND.name })).toBeDefined();
  });

  it('a delivered asset carries MAKAM as its alt text, not a filename', () => {
    const assets: BrandAssetSet = {
      logo: { src: '/brand/makam-logo.png', width: 1000, height: 250, aspectRatio: 4 },
      mark: { src: '/brand/makam-mark.svg', width: 64, height: 64, aspectRatio: 1 },
    };
    const { container } = render(createElement(MakamLogo, { assets }));
    const img = container.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe(BRAND.name);
    expect(img.getAttribute('alt')).not.toMatch(/logo|[.]png|srivillu/i);
  });

  it('the compact mark is still named', () => {
    render(createElement(MakamMark, { size: 24 }));
    expect(screen.getByRole('img', { name: BRAND.name })).toBeDefined();
  });

  it('every shell variant shows MAKAM and never the old brand', () => {
    for (const role of ['ADMIN', 'OPERATIONS', 'INVESTOR'] as const) {
      const { container } = renderShell(role, role === 'INVESTOR' ? '/admin/portfolio' : '/admin/dashboard');
      const text = container.textContent ?? '';
      expect(text, role).toContain('MAKAM');
      expect(text, role).not.toMatch(/srivillu/i);
      cleanup();
    }
  });

  it('the copilot is branded MAKAM in the menu', () => {
    const labels = NAVIGATION.flatMap((s) => s.items.map((i) => i.label));
    expect(labels).toContain('MAKAM Copilot');
    expect(labels.join(' ')).not.toMatch(/srivillu/i);
  });

  it('every page title carries the product name', () => {
    const pages = walk('app').filter((f) => f.endsWith('page.tsx'));
    const titled = pages.filter((f) => read(f).includes('export const metadata'));
    expect(titled.length).toBeGreaterThan(15);
    for (const file of titled) {
      const title = /title:\s*["'`]([^"'`]+)["'`]/.exec(read(file))?.[1] ?? '';
      expect(title, file).toContain('MAKAM');
      expect(title, file).not.toMatch(/srivillu/i);
    }
  });

  it('the root metadata derives from BRAND rather than hardcoding a name', () => {
    const layout = read('app/layout.tsx');
    expect(layout).toContain('BRAND.name');
    expect(layout).not.toMatch(/srivillu/i);
  });
});

/* ================================================================== *
 * 3 · Nothing user-facing was missed
 * ================================================================== */

describe('brand · no stale user-facing reference survives', () => {
  it('no rendered string in app/ or components/ says the old brand', () => {
    /*
     * Comments are excluded deliberately: a header noting the design system was built
     * under the previous brand is history, not product copy. Anything a user could READ
     * is what this asserts on.
     */
    const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const offenders: string[] = [];
    for (const file of [...walk('app'), ...walk('components')]) {
      if (/srivillu/i.test(codeOnly(read(file)))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('the shared layer names only MAKAM in values a user can see', () => {
    for (const file of ['lib/shared/brand.ts', 'lib/shared/navigation.ts', 'lib/shared/environment.ts']) {
      const strings = [...read(file).matchAll(/['"`]([^'"`\n]{3,})['"`]/g)].map((m) => m[1]!);
      for (const value of strings) {
        expect(value, `${file}: ${value}`).not.toMatch(/srivillu/i);
      }
    }
  });
});

/* ================================================================== *
 * 4 · Internals were NOT renamed to chase the logo
 * ================================================================== */

describe('brand · the migration stayed out of the machinery', () => {
  it('the sv- class prefix survives — it is pinned by tests and the design system', () => {
    // Renaming ~200 selectors buys a user nothing and breaks every pinned assertion.
    const css = read('styles/app.css');
    expect(css).toContain('.sv-shell');
    expect(css).toContain('.sv-logo__word');
    expect(css).not.toContain('.makam-shell');
  });

  it('the Verandah Ledger design system keeps its name', () => {
    // An internal design-system name, explicitly not customer-facing branding.
    expect(fs.existsSync(path.join(ROOT, 'docs/SRIVILLU_DESIGN_SYSTEM.md'))).toBe(true);
  });

  it('contract, environment and package identifiers are untouched', () => {
    const pkg = JSON.parse(read('package.json')) as { name: string };
    expect(pkg.name).toBe('homestay-web');
    expect(read('.env.example')).not.toMatch(/makam/i);
  });

  it('demo strings that reach a screen carry the new brand', () => {
    /*
     * Two of these are genuinely displayed and were easy to miss, because neither sits
     * in app/ or components/: the dataset marker is printed on the demo-controls page
     * (app/admin/demo/page.tsx renders `status.marker`), and the guest-journey script
     * shows a guest their Wi-Fi name. Both are product copy despite living in lib/.
     */
    expect(read('lib/data/demo/dataset.ts')).toContain("DEMO_MARKER = 'MAKAM-DEMO'");
    expect(read('lib/server/demo/guest-journey.ts')).toContain('MAKAM-GUEST');
    // Neither file may carry the old brand in any quoted value.
    for (const file of ['lib/data/demo/dataset.ts', 'lib/server/demo/guest-journey.ts']) {
      const codeOnly = read(file).replace(/\/\*[\s\S]*?\*\//g, ' ');
      expect(codeOnly, file).not.toMatch(/srivillu/i);
    }
  });

  it('demo account identifiers are NOT rebranded — they are real credentials', () => {
    /*
     * The demo sign-in accounts exist in a provisioned Supabase project and are
     * authenticated by e2e/real-demo.spec.ts with passwords from DEMO_E2E_* env vars.
     * Renaming the address in code would simply fail to sign in. They are also never
     * displayed: the chooser renders name, role and purpose only, which is why the
     * old-brand domain is invisible to anyone using the product.
     */
    const identities = read('lib/server/auth/demo-identities.ts');
    expect(identities).toContain('@srivillu.demo');
    const signin = read('app/signin/page.tsx');
    expect(signin).toContain('identity.name');
    expect(signin).not.toContain('identity.email');
  });

  it('the demo session cookie keeps its name — renaming it signs everyone out', () => {
    expect(read('lib/server/auth/demo-identities.ts')).toContain("'srivillu_demo_identity'");
  });

  it('the parity guard still recognises the real workbook by its own title', () => {
    /*
     * The production spreadsheet is external property and was not renamed by this
     * migration. The guard matches on parity/copy/test/sandbox, never on the brand, so
     * the fixtures describing the real workbook stay exactly as they are.
     */
    const preflight = read('tests/parity-preflight.test.ts');
    expect(preflight).toContain('Srivillu Home Stays');
    expect(read('scripts/parity-scan.mjs')).toContain('sandbox');
  });
});
