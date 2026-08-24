import { redirect } from 'next/navigation';

export default function AnalyticsIndex() {
  redirect('/admin/analytics/performance');
}
