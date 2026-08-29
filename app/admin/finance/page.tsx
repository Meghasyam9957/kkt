import { redirect } from 'next/navigation';

/**
 * The Finance breadcrumb segment needs a real destination — this used to 404, which made
 * the trail a trap. Same pattern as /admin/analytics: land on the section's first screen.
 */
export default function FinanceIndex() {
  redirect('/admin/finance/revenue');
}
