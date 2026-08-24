import '@/lib/server/only';
/**
 * Server-side entry point for the role model.
 *
 * The model itself lives in `@/lib/shared/roles` so that client navigation can read the
 * capability table without importing a server-guarded module. This file re-exports it for
 * server consumers — the guard, the route table, the session resolver — so those keep a
 * single import path and the server-only guard keeps applying to them.
 */
export {
  ROLES, CAPABILITIES, capabilitiesFor, roleHasCapability, isRole,
  PII_CAPABILITIES, FINANCIAL_CAPABILITIES, WRITE_CAPABILITIES,
} from '@/lib/shared/roles';
export type { Role, Capability } from '@/lib/shared/roles';
