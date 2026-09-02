-- =====================================================================
-- 0009 · TENANT REFERENTIAL INTEGRITY
--
-- Found by running the schema rather than reading it (M-INFRA-1).
--
-- THE HOLE THIS CLOSES. Twenty-four foreign keys pointed at a parent row BY ID ALONE,
-- across finance, HR and operations. Every one of them would happily accept a child row
-- in tenant A referencing a parent row in tenant B:
--
--     insert into finance_bills (tenant_id, vendor_id, ...)
--     values (<tenant A>, <a vendor belonging to tenant B>, ...);   -- accepted
--
-- and likewise attendance against another tenant's employee, a payroll line against
-- another tenant's run, a task assignment against another tenant's staff. The database
-- stored these without complaint. The only thing preventing them was application code
-- remembering to check, every time, in every path.
--
-- That is a real boundary resting on vigilance. One forgotten check in one handler and a
-- customer's ledger silently references another customer's supplier — with no error, no
-- audit entry, and nothing to notice it later.
--
-- THE FIX. Each parent gains a UNIQUE (tenant_id, id) — redundant against its primary key,
-- and that redundancy is the point: it is what lets a composite foreign key exist. Each
-- child key is then re-pointed at (tenant_id, <ref>) so the tenant must match for the
-- reference to resolve at all. A cross-tenant reference stops being something the
-- application must prevent and becomes something the database cannot represent.
--
-- ON DELETE behaviour is carried across unchanged, cascade and restrict alike. No column
-- is added, dropped or retyped; no row is touched. A database where the application has
-- been behaving correctly will apply this with nothing to fix.
--
-- WHY A NEW MIGRATION RATHER THAN AN EDIT to 0006/0007/0008: those files are the record of
-- what was applied, and the runner checksums them. Editing an applied migration makes the
-- ledger disagree with the repository — which is precisely the drift M-INFRA-1 added
-- detection for. Forward fix, always.
--
-- NULL is still NULL: a composite foreign key with a NULL reference column is not enforced
-- (MATCH SIMPLE), so an optional reference stays optional. tenant_id is NOT NULL on every
-- table here, so the tenant half is never the missing one.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Every referenced parent becomes addressable by (tenant, row)
-- ---------------------------------------------------------------------
do $$ begin
  alter table finance_bills add constraint finance_bills_tenant_row_unique unique (tenant_id, id);
exception when duplicate_table then null; when duplicate_object then null; end $$;
do $$ begin
  alter table finance_payments add constraint finance_payments_tenant_row_unique unique (tenant_id, id);
exception when duplicate_table then null; when duplicate_object then null; end $$;
do $$ begin
  alter table finance_receivables add constraint finance_receivables_tenant_row_unique unique (tenant_id, id);
exception when duplicate_table then null; when duplicate_object then null; end $$;
do $$ begin
  alter table finance_vendors add constraint finance_vendors_tenant_row_unique unique (tenant_id, id);
exception when duplicate_table then null; when duplicate_object then null; end $$;
do $$ begin
  alter table hr_departments add constraint hr_departments_tenant_row_unique unique (tenant_id, id);
exception when duplicate_table then null; when duplicate_object then null; end $$;
do $$ begin
  alter table hr_designations add constraint hr_designations_tenant_row_unique unique (tenant_id, id);
exception when duplicate_table then null; when duplicate_object then null; end $$;
do $$ begin
  alter table hr_employee_advances add constraint hr_employee_advances_tenant_row_unique unique (tenant_id, id);
exception when duplicate_table then null; when duplicate_object then null; end $$;
do $$ begin
  alter table hr_employees add constraint hr_employees_tenant_row_unique unique (tenant_id, id);
exception when duplicate_table then null; when duplicate_object then null; end $$;
do $$ begin
  alter table hr_leave_types add constraint hr_leave_types_tenant_row_unique unique (tenant_id, id);
exception when duplicate_table then null; when duplicate_object then null; end $$;
do $$ begin
  alter table hr_payroll_lines add constraint hr_payroll_lines_tenant_row_unique unique (tenant_id, id);
exception when duplicate_table then null; when duplicate_object then null; end $$;
do $$ begin
  alter table hr_payroll_runs add constraint hr_payroll_runs_tenant_row_unique unique (tenant_id, id);
exception when duplicate_table then null; when duplicate_object then null; end $$;
do $$ begin
  alter table hr_salary_structures add constraint hr_salary_structures_tenant_row_unique unique (tenant_id, id);
exception when duplicate_table then null; when duplicate_object then null; end $$;
do $$ begin
  alter table hr_shifts add constraint hr_shifts_tenant_row_unique unique (tenant_id, id);
exception when duplicate_table then null; when duplicate_object then null; end $$;
do $$ begin
  alter table ops_task_assignments add constraint ops_task_assignments_tenant_row_unique unique (tenant_id, id);
exception when duplicate_table then null; when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 2. Every child key carries the tenant into the reference
--
-- Dropped and re-added rather than altered: PostgreSQL has no ALTER CONSTRAINT that can
-- change a foreign key's column list. The pair runs inside the migration's transaction, so
-- there is no window in which the table sits with no key at all.
-- ---------------------------------------------------------------------
alter table finance_bills drop constraint if exists finance_bills_vendor_id_fkey;
do $$ begin
  alter table finance_bills add constraint finance_bills_vendor_id_fkey
    foreign key (tenant_id, vendor_id) references finance_vendors (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table finance_payments drop constraint if exists finance_payments_bill_id_fkey;
do $$ begin
  alter table finance_payments add constraint finance_payments_bill_id_fkey
    foreign key (tenant_id, bill_id) references finance_bills (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table finance_payments drop constraint if exists finance_payments_employee_advance_id_fkey;
do $$ begin
  alter table finance_payments add constraint finance_payments_employee_advance_id_fkey
    foreign key (tenant_id, employee_advance_id) references hr_employee_advances (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table finance_payments drop constraint if exists finance_payments_payroll_line_id_fkey;
do $$ begin
  alter table finance_payments add constraint finance_payments_payroll_line_id_fkey
    foreign key (tenant_id, payroll_line_id) references hr_payroll_lines (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table finance_payments drop constraint if exists finance_payments_receivable_id_fkey;
do $$ begin
  alter table finance_payments add constraint finance_payments_receivable_id_fkey
    foreign key (tenant_id, receivable_id) references finance_receivables (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table finance_payments drop constraint if exists finance_payments_reverses_id_fkey;
do $$ begin
  alter table finance_payments add constraint finance_payments_reverses_id_fkey
    foreign key (tenant_id, reverses_id) references finance_payments (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table hr_attendance drop constraint if exists hr_attendance_employee_id_fkey;
do $$ begin
  alter table hr_attendance add constraint hr_attendance_employee_id_fkey
    foreign key (tenant_id, employee_id) references hr_employees (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table hr_attendance drop constraint if exists hr_attendance_shift_id_fkey;
do $$ begin
  alter table hr_attendance add constraint hr_attendance_shift_id_fkey
    foreign key (tenant_id, shift_id) references hr_shifts (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table hr_employee_advances drop constraint if exists hr_employee_advances_employee_id_fkey;
do $$ begin
  alter table hr_employee_advances add constraint hr_employee_advances_employee_id_fkey
    foreign key (tenant_id, employee_id) references hr_employees (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table hr_employees drop constraint if exists hr_employees_department_id_fkey;
do $$ begin
  alter table hr_employees add constraint hr_employees_department_id_fkey
    foreign key (tenant_id, department_id) references hr_departments (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table hr_employees drop constraint if exists hr_employees_designation_id_fkey;
do $$ begin
  alter table hr_employees add constraint hr_employees_designation_id_fkey
    foreign key (tenant_id, designation_id) references hr_designations (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table hr_employees drop constraint if exists hr_employees_manager_id_fkey;
do $$ begin
  alter table hr_employees add constraint hr_employees_manager_id_fkey
    foreign key (tenant_id, manager_id) references hr_employees (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table hr_leave_entitlements drop constraint if exists hr_leave_entitlements_employee_id_fkey;
do $$ begin
  alter table hr_leave_entitlements add constraint hr_leave_entitlements_employee_id_fkey
    foreign key (tenant_id, employee_id) references hr_employees (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table hr_leave_entitlements drop constraint if exists hr_leave_entitlements_leave_type_id_fkey;
do $$ begin
  alter table hr_leave_entitlements add constraint hr_leave_entitlements_leave_type_id_fkey
    foreign key (tenant_id, leave_type_id) references hr_leave_types (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table hr_leave_requests drop constraint if exists hr_leave_requests_employee_id_fkey;
do $$ begin
  alter table hr_leave_requests add constraint hr_leave_requests_employee_id_fkey
    foreign key (tenant_id, employee_id) references hr_employees (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table hr_leave_requests drop constraint if exists hr_leave_requests_leave_type_id_fkey;
do $$ begin
  alter table hr_leave_requests add constraint hr_leave_requests_leave_type_id_fkey
    foreign key (tenant_id, leave_type_id) references hr_leave_types (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table hr_overtime drop constraint if exists hr_overtime_employee_id_fkey;
do $$ begin
  alter table hr_overtime add constraint hr_overtime_employee_id_fkey
    foreign key (tenant_id, employee_id) references hr_employees (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table hr_payroll_lines drop constraint if exists hr_payroll_lines_employee_id_fkey;
do $$ begin
  alter table hr_payroll_lines add constraint hr_payroll_lines_employee_id_fkey
    foreign key (tenant_id, employee_id) references hr_employees (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table hr_payroll_lines drop constraint if exists hr_payroll_lines_run_id_fkey;
do $$ begin
  alter table hr_payroll_lines add constraint hr_payroll_lines_run_id_fkey
    foreign key (tenant_id, run_id) references hr_payroll_runs (tenant_id, id) on delete cascade;
exception when duplicate_object then null; end $$;
alter table hr_payroll_lines drop constraint if exists hr_payroll_lines_structure_id_fkey;
do $$ begin
  alter table hr_payroll_lines add constraint hr_payroll_lines_structure_id_fkey
    foreign key (tenant_id, structure_id) references hr_salary_structures (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table hr_salary_components drop constraint if exists hr_salary_components_structure_id_fkey;
do $$ begin
  alter table hr_salary_components add constraint hr_salary_components_structure_id_fkey
    foreign key (tenant_id, structure_id) references hr_salary_structures (tenant_id, id) on delete cascade;
exception when duplicate_object then null; end $$;
alter table hr_salary_structures drop constraint if exists hr_salary_structures_employee_id_fkey;
do $$ begin
  alter table hr_salary_structures add constraint hr_salary_structures_employee_id_fkey
    foreign key (tenant_id, employee_id) references hr_employees (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table ops_task_assignments drop constraint if exists ops_task_assignments_employee_id_fkey;
do $$ begin
  alter table ops_task_assignments add constraint ops_task_assignments_employee_id_fkey
    foreign key (tenant_id, employee_id) references hr_employees (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
alter table ops_task_assignments drop constraint if exists ops_task_assignments_superseded_by_fkey;
do $$ begin
  alter table ops_task_assignments add constraint ops_task_assignments_superseded_by_fkey
    foreign key (tenant_id, superseded_by) references ops_task_assignments (tenant_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
