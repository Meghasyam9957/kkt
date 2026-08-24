import { redirect } from 'next/navigation';
import { getShellSession } from '@/lib/server/auth/shell-session';
import { AuthenticationError, AuthorizationError } from '@/lib/server/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Land each role on a screen it can actually use.
 *
 * Sending everyone to the financial dashboard would greet an operations manager and an
 * investor with "not available for your role" as the first thing they ever see — which
 * reads as a broken login rather than as a deliberate boundary.
 */
export default async function AdminIndex() {
  let role: string;
  try {
    role = (await getShellSession()).role;
  } catch (error) {
    if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
      redirect('/signin');
    }
    throw error;
  }

  if (role === 'INVESTOR') redirect('/admin/portfolio');
  if (role === 'OPERATIONS') redirect('/admin/operations/today');
  redirect('/admin/dashboard');
}
