/**
 * DEMONSTRATION CONTROLS — scenario switch, reset, seed capture, guest journey.
 *
 * Every action here runs behind `authorizeDemoOperation`, which checks the environment
 * *before* it checks the caller. In production the environment check throws and the
 * request never reaches the question of who is asking — there is no privileged account
 * that can reset a real workbook, because the operation does not exist there.
 *
 * Two demo shapes, and the controls differ honestly between them:
 *
 *   FIXTURES (no demo workbook configured) — scenario switch, reset and guest journey
 *   rebuild the in-process dataset, which is generated from seed and therefore genuinely
 *   restorable. Nothing touches a Google Sheet.
 *
 *   LIVE DEMO WORKBOOK — the dataset on screen comes from the real demo workbook, so the
 *   in-memory scenario controls would *appear* to work while changing nothing visible.
 *   They are refused. Reset instead restores the workbook's seeded input cells from the
 *   captured snapshot (Phase D7), clears the demo project's operation/ID state, and
 *   drops the read cache — verified by read-back, audited, and still impossible outside
 *   the demo environment.
 */
import { NextResponse } from 'next/server';
import { authorizeDemoOperation } from '@/lib/server/demo/authorize';
import { AuthenticationError, AuthorizationError } from '@/lib/server/auth/session';
import { DemoOnlyOperationError } from '@/lib/server/environment/config';
import {
  setScenario, resetDemoEnvironment, setPresentationMode, PresentationModeError,
} from '@/lib/server/demo/store';
import { runGuestJourney } from '@/lib/server/demo/guest-journey';
import { isLiveDataEnabled, getReadCache } from '@/lib/data/providers';
import { resolveTenantDataSource } from '@/lib/server/tenant/data-source';
import {
  captureSeedSnapshot, restoreSeedSnapshot, resetDemoTechnicalState,
  loadSeedSnapshot, saveSeedSnapshot, SeedSnapshotError,
} from '@/lib/server/demo/live-reset';
import { getServiceAudit, __resetApiService } from '@/lib/server/api/service';
import type { ShellSession } from '@/lib/server/auth/shell-session';
import type { ResolvedEnvironment } from '@/lib/server/environment/config';

/** The demo workbook is the data source: reads and writes both go to Google. */
const liveDemoActive = (resolved: ResolvedEnvironment): boolean =>
  resolved.sheets !== null && isLiveDataEnabled();

async function audit(session: ShellSession, action: string, metadata: Record<string, unknown>): Promise<void> {
  await getServiceAudit().record({
    actor: {
      userId: session.userId, email: session.email, role: session.role,
      tenantId: session.tenantId,
      investorId: session.investorId, status: 'ACTIVE',
    },
    action,
    result: 'ALLOW',
    metadata,
  });
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const returnTo = String(form.get('returnTo') ?? '/admin/demo');

  try {
    switch (action) {
      case 'scenario': {
        const { resolved } = await authorizeDemoOperation('Switch demo scenario');
        if (liveDemoActive(resolved)) {
          return NextResponse.json({
            error: 'Scenario switching is not available while the live demo workbook is the '
              + 'data source: it would change the in-memory dataset, which is not what the '
              + 'screen is showing. The live demo presents the workbook\'s seeded story.',
          }, { status: 409 });
        }
        setScenario(String(form.get('scenario') ?? ''), { resolved });
        break;
      }
      case 'reset': {
        const { resolved, session } = await authorizeDemoOperation('Reset demo environment');
        // The confirmation happens in the interface; this is the point of no return, and
        // it is safe precisely because everything it discards is fictional. This also
        // enforces the presentation-mode gate for BOTH demo shapes.
        resetDemoEnvironment({ resolved });

        if (liveDemoActive(resolved)) {
          const snapshot = loadSeedSnapshot();
          if (!snapshot) {
            return NextResponse.json({
              error: 'No seed snapshot has been captured for the demo workbook, so there is '
                + 'nothing trusted to restore to. Capture the seed snapshot (demo controls) '
                + 'right after seeding the workbook, then reset becomes available.',
            }, { status: 409 });
          }
          /*
           * THE ACTING TENANT'S workbook, not the environment's.
           *
           * A demo reset destroys and rebuilds every row it touches, which makes it the
           * most destructive operation in the product — so it is the last place that
           * should resolve a workbook by any route other than the caller's identity. The
           * demonstration deployment has one tenant, so this is the same workbook it
           * always was; what changes is that a second tenant could not reset the first
           * one's data by holding `demo.control` in their own.
           */
          const tenantSource = await resolveTenantDataSource(session.tenantId);
          const report = await restoreSeedSnapshot(tenantSource.client, snapshot);
          const technical = await resetDemoTechnicalState(resolved);
          // In-memory operation/sequence state (used when Supabase is absent) must not
          // survive a reset that claims the environment is back to seed.
          __resetApiService();
          /*
           * Only after a VERIFIED restore: a refused reset must not invalidate good cache.
           *
           * Scoped to the acting tenant. `invalidate('')` prefixes every key in the
           * process, so one tenant's demo-control holder could empty every other tenant's
           * cache — a denial of service one customer can inflict on the rest, and a
           * thundering herd against the workbook read quota. The demonstration deployment
           * has one tenant, so this changes nothing observable today; it stops being true
           * the moment a second one exists.
           */
          getReadCache().invalidate(`tenant=${session.tenantId}|`);
          await audit(session, 'demo.reset.live', {
            restoredRows: report.restoredRows,
            clearedRows: report.clearedRows,
            technicalTablesCleared: technical.cleared,
          });
        }
        break;
      }
      case 'capture-seed': {
        const { resolved, session } = await authorizeDemoOperation('Capture demo seed snapshot');
        if (!liveDemoActive(resolved)) {
          return NextResponse.json({
            error: 'Seed capture applies only to a live demo workbook. The fixtures demo '
              + 'regenerates from code and needs no snapshot.',
          }, { status: 409 });
        }
        // The acting tenant's workbook, for the same reason the reset above uses it.
        const captureSource = await resolveTenantDataSource(session.tenantId);
        const snapshot = await captureSeedSnapshot(captureSource.client);
        saveSeedSnapshot(snapshot);
        await audit(session, 'demo.seed.captured', {
          capturedAt: snapshot.capturedAt,
          seededRows: Object.values(snapshot.sheets).reduce((n, s) => n + (s?.rows.length ?? 0), 0),
        });
        break;
      }
      case 'presentation': {
        const { resolved } = await authorizeDemoOperation('Change presentation mode');
        setPresentationMode({
          active: form.get('active') === 'on',
          // Absent means "leave it as it was" only when presentation mode is being turned
          // off; turning it on states the reset choice explicitly.
          ...(form.has('resetEnabled') ? { resetEnabled: form.get('resetEnabled') === 'on' } : {}),
        }, { resolved });
        break;
      }
      case 'guest-journey': {
        const { resolved } = await authorizeDemoOperation('Run demo guest journey');
        if (liveDemoActive(resolved)) {
          return NextResponse.json({
            error: 'The scripted guest journey drives the in-memory dataset and is not '
              + 'available while the live demo workbook is the data source.',
          }, { status: 409 });
        }
        runGuestJourney({ resolved });
        break;
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof DemoOnlyOperationError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof PresentationModeError) {
      // The control was hidden; the request arrived anyway. Refusing it is what makes the
      // hiding meaningful rather than decorative.
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof SeedSnapshotError) {
      // The reset could not restore or could not PROVE it restored. Saying so beats a
      // redirect that implies success.
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof AuthenticationError) {
      return NextResponse.redirect(new URL('/signin', request.url), 303);
    }
    if (error instanceof AuthorizationError) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }
    throw error;
  }

  // Redirect back so the change is visible immediately rather than reported in JSON.
  const destination = returnTo.startsWith('/') ? returnTo : '/admin/demo';
  return NextResponse.redirect(new URL(destination, request.url), 303);
}
