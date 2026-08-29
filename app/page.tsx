import { redirect } from 'next/navigation';

/**
 * The front door hands off to /admin, where the session is resolved SERVER-SIDE and each
 * role lands on a screen it can actually use (dashboard / today / portfolio / sign-in).
 * Redirecting straight to the financial dashboard greeted two of the four roles with
 * "not available for your role" as their first screen.
 */
export default function Home() {
  redirect('/admin');
}
