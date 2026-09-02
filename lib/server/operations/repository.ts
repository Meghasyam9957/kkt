import '@/lib/server/only';
/**
 * ASSIGNMENT PERSISTENCE — the same shape finance and HR use, for the same reason.
 *
 * Every method takes a `TenantContext` FIRST and none has an overload that omits it. Every
 * tenant's assignments sit in one table, and the only thing between customer A and
 * customer B is a predicate — so it is made structural rather than left to memory.
 *
 * Two implementations, mirroring each other. There is no local Postgres in this project,
 * so the in-memory twin is the only place these semantics are executed and the Supabase
 * twin is verified by recording the query chain it builds.
 */
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@/lib/server/tenant/context';
import { requireTenant } from '@/lib/server/tenant/context';
import type { TaskAssignment, TaskType } from './types';

export interface AssignmentInput {
  taskType: TaskType;
  taskRef: string;
  employeeId: string;
  propertyId: string | null;
  displayNameWritten: string;
  overrideReason?: string | null;
}

export interface AssignmentFilter {
  taskType?: TaskType;
  employeeId?: string;
  propertyId?: string;
  /** Current assignments only, i.e. not superseded. Defaults to true. */
  currentOnly?: boolean;
}

export interface OperationsRepository {
  /**
   * Records a new current assignment, superseding any existing one for the same task.
   *
   * Returns null when another assignment for the same task landed first — the caller
   * surfaces that as a concurrency refusal rather than producing a second current row.
   */
  assign(
    tenant: TenantContext, input: AssignmentInput, actor: string,
  ): Promise<TaskAssignment | null>;

  /** The CURRENT assignment for one task, or null. */
  currentFor(
    tenant: TenantContext, taskType: TaskType, taskRef: string,
  ): Promise<TaskAssignment | null>;

  /** Current assignments for many tasks at once, so a board is one read rather than N. */
  currentForMany(
    tenant: TenantContext, taskType: TaskType, taskRefs: readonly string[],
  ): Promise<TaskAssignment[]>;

  /** The full chain for one task, newest first. Append-only, so this is the history. */
  historyFor(
    tenant: TenantContext, taskType: TaskType, taskRef: string,
  ): Promise<TaskAssignment[]>;

  list(tenant: TenantContext, filter?: AssignmentFilter): Promise<TaskAssignment[]>;
}

/* ------------------------------------------------------------------ *
 * In-memory
 * ------------------------------------------------------------------ */

export class InMemoryOperationsRepository implements OperationsRepository {
  private readonly rows = new Map<string, TaskAssignment>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** THE predicate. Everything reads through it; nothing reads around it. */
  private mine(tenant: TenantContext): TaskAssignment[] {
    const { tenantId } = requireTenant(tenant, 'OperationsRepository');
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId);
  }

  async assign(
    tenant: TenantContext, input: AssignmentInput, actor: string,
  ): Promise<TaskAssignment | null> {
    const { tenantId } = requireTenant(tenant, 'assign');
    const stamp = this.now().toISOString();

    const existing = this.mine(tenant).find((row) => row.taskType === input.taskType
      && row.taskRef === input.taskRef && row.supersededAt === null);

    const created: TaskAssignment = Object.freeze({
      id: randomUUID(),
      tenantId,
      taskType: input.taskType,
      taskRef: input.taskRef,
      employeeId: input.employeeId,
      propertyId: input.propertyId,
      displayNameWritten: input.displayNameWritten,
      assignedBy: actor,
      assignedAt: stamp,
      supersededAt: null,
      supersededBy: null,
      overrideReason: input.overrideReason?.trim() || null,
    });

    if (existing) {
      // Supersession, never deletion: the previous row keeps its dates and its actor, and
      // points forward at what replaced it.
      this.rows.set(existing.id, Object.freeze({
        ...existing, supersededAt: stamp, supersededBy: created.id,
      }));
    }
    this.rows.set(created.id, created);
    return created;
  }

  async currentFor(
    tenant: TenantContext, taskType: TaskType, taskRef: string,
  ): Promise<TaskAssignment | null> {
    return this.mine(tenant).find((row) => row.taskType === taskType
      && row.taskRef === taskRef && row.supersededAt === null) ?? null;
  }

  async currentForMany(
    tenant: TenantContext, taskType: TaskType, taskRefs: readonly string[],
  ): Promise<TaskAssignment[]> {
    const wanted = new Set(taskRefs);
    return this.mine(tenant).filter((row) => row.taskType === taskType
      && row.supersededAt === null && wanted.has(row.taskRef));
  }

  async historyFor(
    tenant: TenantContext, taskType: TaskType, taskRef: string,
  ): Promise<TaskAssignment[]> {
    return this.mine(tenant)
      .filter((row) => row.taskType === taskType && row.taskRef === taskRef)
      .sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
  }

  async list(tenant: TenantContext, filter: AssignmentFilter = {}): Promise<TaskAssignment[]> {
    const currentOnly = filter.currentOnly ?? true;
    return this.mine(tenant)
      .filter((row) => (currentOnly ? row.supersededAt === null : true))
      .filter((row) => (filter.taskType ? row.taskType === filter.taskType : true))
      .filter((row) => (filter.employeeId ? row.employeeId === filter.employeeId : true))
      .filter((row) => (filter.propertyId ? row.propertyId === filter.propertyId : true))
      .sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
  }
}

/* ------------------------------------------------------------------ *
 * Postgres
 * ------------------------------------------------------------------ */

/**
 * Deliberately logic-free, exactly as the finance and HR twins are. Nothing in this project
 * executes this SQL, so a rule expressed here would be a rule nothing verifies; the rules
 * live in `service.ts`. Two helpers touch the database and both carry the tenant.
 */
export class SupabaseOperationsRepository implements OperationsRepository {
  constructor(private readonly client: any) {}

  private scoped(tenant: TenantContext): any {
    const { tenantId } = requireTenant(tenant, 'SupabaseOperationsRepository');
    return this.client.from('ops_task_assignments').select('*').eq('tenant_id', tenantId);
  }

  private static rows(result: { data: unknown; error: unknown }): any[] {
    if (result.error) {
      throw new Error(String((result.error as { message?: string }).message ?? 'query failed'));
    }
    return (result.data ?? []) as any[];
  }

  async assign(
    tenant: TenantContext, input: AssignmentInput, actor: string,
  ): Promise<TaskAssignment | null> {
    const { tenantId } = requireTenant(tenant, 'assign');
    const stamp = new Date().toISOString();

    /*
     * SUPERSEDE FIRST, exactly as the in-memory twin does.
     *
     * Without this the insert below always collided with `ops_assignment_one_current` on
     * the second assignment of a task, returned null, and the service reported
     * ALREADY_ASSIGNED — so no task could ever be reassigned through a real database. The
     * two twins disagreed and nothing noticed, because the recorder harness asserts the
     * query chain a repository builds and never runs it against a schema.
     *
     * The previous row keeps its own dates and actor; only its supersession is written, and
     * `superseded_by` is filled in after the replacement exists so it points at something
     * real. Both predicates on the update, as everywhere else.
     */
    const superseded = await this.client
      .from('ops_task_assignments')
      .update({ superseded_at: stamp })
      .eq('tenant_id', tenantId)
      .eq('task_type', input.taskType)
      .eq('task_ref', input.taskRef)
      .is('superseded_at', null)
      .select('id');
    if (superseded.error) {
      throw new Error(String(superseded.error.message ?? 'supersede failed'));
    }
    const previousIds = ((superseded.data ?? []) as { id: string }[]).map((r) => r.id);

    const { data, error } = await this.client
      .from('ops_task_assignments')
      // `tenant_id` LAST, so a caller-supplied one is overwritten rather than honoured.
      .insert({
        task_type: input.taskType,
        task_ref: input.taskRef,
        employee_id: input.employeeId,
        property_id: input.propertyId,
        display_name_written: input.displayNameWritten,
        assigned_by: actor,
        assigned_at: stamp,
        override_reason: input.overrideReason?.trim() || null,
        tenant_id: tenantId,
      })
      .select('*')
      .single();

    /*
     * A unique-index violation here is the concurrency case, not a bug: another supervisor
     * assigned this task between our read and our write. Reported as null so the service
     * can say so, rather than raised as an unexplained database error.
     */
    if (error) {
      if (String(error.code) === '23505') return null;
      throw new Error(String(error.message ?? 'assignment insert failed'));
    }

    // Point the superseded row forward at what replaced it, now that it exists. A failure
    // here leaves the history readable — the row is already marked superseded and the new
    // one is current — so it is not worth failing the assignment over.
    if (previousIds.length > 0) {
      await this.client
        .from('ops_task_assignments')
        .update({ superseded_by: (data as { id: string }).id })
        .eq('tenant_id', tenantId)
        .in('id', previousIds);
    }

    return toAssignment(data);
  }

  async currentFor(
    tenant: TenantContext, taskType: TaskType, taskRef: string,
  ): Promise<TaskAssignment | null> {
    const { data, error } = await this.scoped(tenant)
      .eq('task_type', taskType).eq('task_ref', taskRef).is('superseded_at', null)
      .maybeSingle();
    if (error) throw new Error(String(error.message ?? 'assignment read failed'));
    return data ? toAssignment(data) : null;
  }

  async currentForMany(
    tenant: TenantContext, taskType: TaskType, taskRefs: readonly string[],
  ): Promise<TaskAssignment[]> {
    if (taskRefs.length === 0) return [];
    return SupabaseOperationsRepository.rows(
      await this.scoped(tenant)
        .eq('task_type', taskType).is('superseded_at', null).in('task_ref', [...taskRefs]),
    ).map(toAssignment);
  }

  async historyFor(
    tenant: TenantContext, taskType: TaskType, taskRef: string,
  ): Promise<TaskAssignment[]> {
    return SupabaseOperationsRepository.rows(
      await this.scoped(tenant)
        .eq('task_type', taskType).eq('task_ref', taskRef)
        .order('assigned_at', { ascending: false }),
    ).map(toAssignment);
  }

  async list(tenant: TenantContext, filter: AssignmentFilter = {}): Promise<TaskAssignment[]> {
    let query = this.scoped(tenant);
    if (filter.currentOnly ?? true) query = query.is('superseded_at', null);
    if (filter.taskType) query = query.eq('task_type', filter.taskType);
    if (filter.employeeId) query = query.eq('employee_id', filter.employeeId);
    if (filter.propertyId) query = query.eq('property_id', filter.propertyId);
    return SupabaseOperationsRepository.rows(
      await query.order('assigned_at', { ascending: false }),
    ).map(toAssignment);
  }
}

function toAssignment(row: any): TaskAssignment {
  return Object.freeze({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    taskType: row.task_type,
    taskRef: String(row.task_ref),
    employeeId: String(row.employee_id),
    propertyId: row.property_id ?? null,
    displayNameWritten: String(row.display_name_written),
    assignedBy: row.assigned_by ?? null,
    assignedAt: String(row.assigned_at),
    supersededAt: row.superseded_at ?? null,
    supersededBy: row.superseded_by ?? null,
    overrideReason: row.override_reason ?? null,
  });
}
