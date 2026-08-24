-- =====================================================================
-- 0002 · DEMO IDENTITIES
--
-- Apply this to the **srivillu-demo** project only. It creates the four demonstration
-- accounts in `app_users` so the platform can be shown with real Supabase authentication
-- rather than the built-in identity chooser.
--
-- It creates no passwords and no auth users. Supabase Auth owns those: invite each address
-- from the dashboard (Authentication ▸ Users ▸ Invite) and the person sets their own
-- password through the link. A password written in a migration is a password in version
-- control, and eventually in production.
--
-- The `id` column must match the Supabase Auth user id, so run this AFTER inviting the
-- four addresses and substitute the ids the dashboard shows. The placeholders below make
-- that step impossible to skip by accident: they are not valid uuids.
--
-- NEVER apply this file to the production project. These are fictional accounts and their
-- presence in a production `app_users` table would be four unexplained logins.
-- =====================================================================

-- Guard: refuse to run where production data lives. Adjust the marker to whatever your
-- production project sets; the point is that this file cannot be applied by mistake.
do $$
begin
  if exists (select 1 from app_users where email not like '%@srivillu.demo' limit 1) then
    raise exception
      'app_users already contains non-demo accounts. This migration is for the srivillu-demo project only.';
  end if;
end
$$;

insert into app_users (id, email, role, investor_id, status)
values
  -- Replace each UUID with the Supabase Auth user id created by the invitation.
  ('00000000-0000-0000-0000-000000000001', 'admin.demo@srivillu.demo',        'ADMIN',      null,      'ACTIVE'),
  ('00000000-0000-0000-0000-000000000002', 'operations.demo@srivillu.demo',   'OPERATIONS', null,      'ACTIVE'),
  ('00000000-0000-0000-0000-000000000003', 'investor.demo.a@srivillu.demo',   'INVESTOR',   'INV-001', 'ACTIVE'),
  ('00000000-0000-0000-0000-000000000004', 'investor.demo.b@srivillu.demo',   'INVESTOR',   'INV-002', 'ACTIVE')
on conflict (id) do update
  set email       = excluded.email,
      role        = excluded.role,
      investor_id = excluded.investor_id,
      status      = excluded.status;

-- Investor A and Investor B are mapped to different investor ids on purpose: the isolation
-- demonstration is only convincing if the two portfolios are visibly different, and that
-- difference starts here.
--
-- The application never accepts an investor id from a request. It reads it from this table,
-- keyed by the verified Supabase user id. A signed-in investor therefore cannot ask for
-- another investor's figures — there is no parameter through which to ask.
