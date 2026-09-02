import '@/lib/server/only';
/**
 * MUTATION PIPELINE — the one way a business record is written.
 *
 * `executeMutation` composes every layer in order, and there is no exported way to run a
 * subset. Handlers hold a MutationDefinition and a context; they cannot reach the
 * repositories, the allocator or the client directly (the security suite additionally
 * forbids write calls anywhere under app/, components/ or lib/data/).
 *
 *   1  environment gate      — writes disabled here? controlled 403 WRITES_DISABLED
 *   2  schema validation     — zod: shape + contract vocabularies       → 422
 *   3  contract validation   — every target column is role:'in'         → 422 CONTRACT_VIOLATION
 *   4  business validation   — referential checks, no arithmetic        → 422
 *   5  idempotency begin     — operations store decides winner/replay   → 200 replay | 409
 *   6  ID allocation         — atomic, keyed by the operation id
 *   7  sheet write           — first-blank-row create / verified update
 *   8  read-after-write      — the row must round-trip, ID in place
 *   9  cache invalidation    — every workbook-derived read is stale now
 *  10  operation VERIFIED    — or FAILED with the real reason
 *  11  audit                 — actor, action, entity, operation id, redacted before/after
 *  12  response              — the verified record + provenance meta
 *
 * The guard (authentication, RBAC, investor-scope refusal, audit of denials) has already
 * run before the pipeline is reached — it wraps every route in the registry.
 */
import type { ZodType } from 'zod';
import { SHEETS, ID_RULES, inputColumns, type SheetKey } from '@/lib/contract/contract.generated';
import type { Repositories, SheetRepository, VerifiedWrite } from '@/lib/server/sheets/repositories';
import { SheetWriteVerifyError } from '@/lib/server/sheets/repositories';
import { SheetWriteForbiddenError, type Row } from '@/lib/server/sheets/client';
import { IdAllocator } from '@/lib/server/ids/allocator';
import { requireTenant } from '@/lib/server/tenant/context';
import { requestHashOf, type OperationStore } from '@/lib/server/ops/operation-store';
import type { AuditService } from '@/lib/server/audit/logger';
import type { HandlerContext } from '@/lib/server/auth/guard';
import type { ReadCache } from '@/lib/server/cache/read-cache';
import { isoToSerial } from '@/lib/shared/dates';

/* ------------------------------------------------------------------ *
 * Errors → controlled responses
 * ------------------------------------------------------------------ */

export class MutationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'MutationError';
  }
}

/* ------------------------------------------------------------------ *
 * Definition
 * ------------------------------------------------------------------ */

export interface MutationContextData {
  repos: Repositories;
  /** The parsed, schema-valid input. */
  input: Record<string, unknown>;
  /** For updates: the entity id from the route path. */
  entityId?: string;
  auth: HandlerContext['auth'];
}

export interface MutationDefinition {
  /** Matches the route registry's `action`, e.g. 'expense.create'. */
  action: string;
  sheet: SheetKey;
  kind: 'create' | 'update';
  schema: ZodType<any>;
  /** The sheet's identifier column key, e.g. 'ExpenseID'. */
  idKey: string;
  /** Create only: mint the ID from the atomic allocator (sheet must be in ID_RULES). */
  allocatesId?: boolean;
  /**
   * Referential business checks — existence, transitions, sanity. Returns human
   * sentences; a non-empty array is a 422. NEVER computes a financial figure.
   */
  validate?: (ctx: MutationContextData) => Promise<string[]>;
  /**
   * Schema-valid input → sheet column values (INPUT columns only; dates as ISO strings
   * are converted to serials here via `dateColumns`). `id` is the allocated or path id.
   */
  toColumns: (input: Record<string, unknown>, id: string) => Record<string, unknown>;
  /** Column keys whose values arrive as ISO dates and must be written as serials. */
  dateColumns?: readonly string[];
  /** Update only: narrow the row match beyond the ID column (composite-key sheets). */
  where?: (input: Record<string, unknown>) => ((row: Row) => boolean) | undefined;
}

export interface MutationDependencies {
  repos: Repositories;
  store: OperationStore;
  allocator: IdAllocator;
  audit: AuditService;
  cache: ReadCache;
  /** From the resolved environment. When false, step 1 refuses every mutation. */
  writesPermitted: boolean;
  clock?: () => Date;
}

export interface MutationResult {
  record: Record<string, unknown>;
  meta: {
    operationId: string;
    verified: boolean;
    rowNumber: number;
    sheet: string;
    /** True when this response was replayed from an earlier identical request. */
    replayed: boolean;
  };
}

/* ------------------------------------------------------------------ *
 * The pipeline
 * ------------------------------------------------------------------ */

export async function executeMutation(
  def: MutationDefinition,
  ctx: HandlerContext,
  deps: MutationDependencies,
): Promise<MutationResult> {
  /* ---- 1 · environment gate -------------------------------------- */
  if (!deps.writesPermitted) {
    throw new MutationError(403, 'WRITES_DISABLED',
      'Writes are not enabled in this environment. Reads are unaffected.');
  }

  /* ---- 2 · schema (shape + vocabulary) --------------------------- */
  const parsed = def.schema.safeParse(ctx.request.body ?? {});
  if (!parsed.success) {
    throw new MutationError(422, 'VALIDATION', 'The request does not match the expected shape.',
      parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`));
  }
  const input = parsed.data as Record<string, unknown>;
  const operationId = String(input.operationId);
  const entityId = ctx.request.params?.id;
  /*
   * WHOSE write this is. From the guard's authenticated context and nowhere else —
   * resolved once, here, so every later step (id scope, idempotency, cache
   * invalidation, audit) uses the same answer and none of them can be handed a
   * different one.
   */
  const tenantId = requireTenant(ctx.auth, 'executeMutation').tenantId;

  /* ---- 3 · contract validation ----------------------------------- */
  // Probe the mapping with a placeholder id: every key it can ever emit must be a
  // role:'in' column of the target sheet. This runs BEFORE anything is written and is
  // independent of buildInputRow's own throw — two layers, same rule.
  const writable = new Set(inputColumns(def.sheet).map((c) => c.key));
  const probe = def.toColumns(input, entityId ?? 'PROBE-0000');
  const violations = Object.keys(probe).filter((key) => !writable.has(key));
  if (violations.length > 0) {
    throw new MutationError(422, 'CONTRACT_VIOLATION',
      `Refusing to write ${violations.map((v) => `${def.sheet}.${v}`).join(', ')}: ` +
      'not input columns of the V1 contract (calculated columns are owned by the workbook).');
  }

  /* ---- 4 · business validation ----------------------------------- */
  if (def.validate) {
    const problems = await def.validate({
      repos: deps.repos, input, auth: ctx.auth,
      ...(entityId !== undefined ? { entityId } : {}),
    });
    if (problems.length > 0) {
      throw new MutationError(422, 'BUSINESS_VALIDATION', 'The request is not valid.', problems);
    }
  }

  /* ---- 5 · idempotency begin ------------------------------------- */
  // The hash covers the payload minus nothing: the same intent must arrive identical.
  const requestHash = requestHashOf({ action: def.action, entityId: entityId ?? null, input });
  const begun = await deps.store.begin({
    operationId,
    tenantId,
    actorId: ctx.auth.userId ?? null,
    actorRole: ctx.auth.role,
    action: def.action,
    requestHash,
  });

  if (begun.outcome === 'verified') {
    // The earlier identical request finished. Same intent, same answer, no second row.
    return begun.result as MutationResult;
  }
  if (begun.outcome === 'in-flight') {
    throw new MutationError(409, 'OPERATION_IN_FLIGHT',
      `Operation ${operationId} is already being applied. Poll /api/operations-log/${operationId}.`);
  }
  if (begun.outcome === 'failed') {
    throw new MutationError(409, 'OPERATION_FAILED_BEFORE',
      `Operation ${operationId} already failed (${begun.error ?? 'no reason recorded'}). ` +
      'Review the failure, then submit again with a new operation id.');
  }
  if (begun.outcome === 'mismatch') {
    throw new MutationError(409, 'OPERATION_MISMATCH',
      `Operation ${operationId} was first submitted with a different payload. ` +
      'An operation id identifies one intent; mint a new id for a new intent.');
  }

  /* ---- from here on, this caller owns the operation --------------- */
  try {
    await deps.store.markApplying(operationId);

    /* ---- 6 · identifier ------------------------------------------ */
    let id: string;
    if (def.kind === 'create') {
      if (def.allocatesId) {
        const year = yearOfInput(input) ?? (deps.clock?.() ?? new Date()).getFullYear();
        /*
         * SEED THE FLOOR before the first allocation in each scope, from the identifiers
         * already in the sheet. Without this, a fresh database starts at 1 and mints ids
         * that already exist in the workbook (hand-typed, or minted by V1's own menu).
         * The floor only ever rises, and re-seeding is idempotent, so doing it lazily
         * here is safe under concurrency — the store serialises both operations.
         */
        // The seeded-scope memo is per TENANT as well as per sheet and year: two
        // customers seeding "RESERVATIONS 2026" are two different number lines, and a
        // shared memo would let the second one skip its own seeding entirely.
        const scope = `tenant:${tenantId}:${def.sheet}:${year}`;
        if (!seededScopes(deps).has(scope)) {
          const existing = await repositoryFor(deps.repos, def.sheet).allIds();
          await deps.allocator.seedFromExistingIds(tenantId, def.sheet, year, existing);
          seededScopes(deps).add(scope);
        }
        const allocation = await deps.allocator.allocate({
          sheet: def.sheet, year, count: 1, idempotencyKey: operationId, actor: ctx.auth,
        });
        id = allocation.ids[0]!;
      } else {
        // Human-assigned identifiers (03_PROPERTIES): the schema validated the format;
        // uniqueness was checked in business validation.
        id = String(probe[def.idKey] ?? '');
        if (!id) {
          throw new MutationError(422, 'VALIDATION', `${def.idKey} is required for this record.`);
        }
      }
    } else {
      if (!entityId) throw new MutationError(422, 'VALIDATION', 'Missing entity id in the path.');
      id = entityId;
    }

    /* ---- 7 + 8 · write, verified ---------------------------------- */
    // Undefined means "field not supplied" — it must never reach a cell write, where it
    // would overwrite an existing value with a blank.
    const columns = stripUndefined(withSerialDates(def.toColumns(input, id), def.dateColumns));
    const repo = repositoryFor(deps.repos, def.sheet);
    let verified: VerifiedWrite;
    if (def.kind === 'create') {
      verified = await repo.createRowVerified({ ...columns, [def.idKey]: id });
    } else {
      const { [def.idKey]: _neverPatchTheId, ...patch } = columns;
      verified = await repo.updateByIdVerified(id, patch, def.where?.(input));
    }

    /* ---- 9 · cache ------------------------------------------------ */
    // A write changes calculated figures everywhere in THIS tenant's workbook (that is
    // the point of the workbook), so every entry of theirs is stale. Scoped to the
    // tenant prefix: one customer's write must not flush another customer's cache, which
    // would be a denial-of-service one tenant could inflict on every other.
    deps.cache.invalidate(`tenant=${tenantId}|`);

    /* ---- 10 · operation state ------------------------------------- */
    const result: MutationResult = {
      record: verified.cells,
      meta: {
        operationId, verified: true, rowNumber: verified.rowNumber,
        sheet: SHEETS[def.sheet], replayed: false,
      },
    };
    await deps.store.complete(operationId, { type: SHEETS[def.sheet], id }, result);

    /* ---- 11 · audit ----------------------------------------------- */
    // `.applied` distinguishes the WRITE event (operation id, row, written cells) from
    // the guard's request-level ALLOW for the same action — one of each per mutation,
    // never two records of the same event.
    await deps.audit.record({
      actor: ctx.auth,
      action: `${def.action}.applied`,
      entityType: SHEETS[def.sheet],
      entityId: id,
      result: 'ALLOW',
      requestId: ctx.request.requestId,
      metadata: {
        operationId, rowNumber: verified.rowNumber,
        // The written input cells only — never the whole row, and the audit logger's
        // redaction pass strips guest PII before anything reaches a sink.
        written: columns,
      },
    });

    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await deps.store.fail(operationId, { type: SHEETS[def.sheet], id: entityId ?? '' }, reason);
    await deps.audit.record({
      actor: ctx.auth, action: def.action, entityType: SHEETS[def.sheet],
      entityId: entityId, result: 'ERROR', reason,
      requestId: ctx.request.requestId, metadata: { operationId },
    });

    if (error instanceof MutationError) throw error;
    if (error instanceof SheetWriteVerifyError) {
      throw new MutationError(502, error.reason,
        `The write could not be verified: ${error.message}. Nothing has been reported as saved.`);
    }
    if (error instanceof SheetWriteForbiddenError) {
      throw new MutationError(403, 'SHEET_FORBIDDEN', error.message);
    }
    throw new MutationError(502, 'WRITE_FAILED',
      'The write did not complete and has been recorded as failed. ' +
      `Operation ${operationId} carries the reason.`);
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function stripUndefined(columns: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(columns).filter(([, v]) => v !== undefined));
}

/** Scopes whose floor has been seeded, held per dependency set (one per process). */
const SEEDED = new WeakMap<MutationDependencies, Set<string>>();
function seededScopes(deps: MutationDependencies): Set<string> {
  let set = SEEDED.get(deps);
  if (!set) { set = new Set(); SEEDED.set(deps, set); }
  return set;
}

/** ISO date strings → sheet serial numbers, for exactly the declared date columns. */
function withSerialDates(
  columns: Record<string, unknown>, dateColumns?: readonly string[],
): Record<string, unknown> {
  if (!dateColumns || dateColumns.length === 0) return columns;
  const out = { ...columns };
  for (const key of dateColumns) {
    const value = out[key];
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      out[key] = isoToSerial(value);
    }
  }
  return out;
}

/** The ID's year scope comes from the record's own primary date, not the wall clock,
 *  so a January entry typed in February still lands in the right sequence. */
function yearOfInput(input: Record<string, unknown>): number | null {
  for (const key of ['date', 'bookingDate', 'dateReported', 'checkoutDate', 'investmentDate']) {
    const value = input[key];
    if (typeof value === 'string' && /^\d{4}-/.test(value)) return Number(value.slice(0, 4));
  }
  return null;
}

function repositoryFor(repos: Repositories, sheet: SheetKey): SheetRepository<unknown> {
  const map: Partial<Record<SheetKey, unknown>> = {
    PROPERTIES: repos.properties,
    RESERVATIONS: repos.reservations,
    REVENUE: repos.revenue,
    EXPENSES: repos.expenses,
    CAPEX: repos.capex,
    RENT: repos.rent,
    CASHFLOW: repos.cashflow,
    INVESTORS: repos.investors,
    DIST: repos.distributions,
    HOUSEKEEPING: repos.housekeeping,
    MAINTENANCE: repos.maintenance,
    INVENTORY: repos.inventory,
  };
  const repo = map[sheet];
  if (!repo) throw new MutationError(500, 'NO_REPOSITORY', `No repository for ${sheet}`);
  return repo as SheetRepository<unknown>;
}

/** Sheets whose identifiers the allocator can mint (everything in ID_RULES). */
export const ALLOCATABLE_SHEETS: ReadonlySet<string> = new Set(Object.keys(ID_RULES));
