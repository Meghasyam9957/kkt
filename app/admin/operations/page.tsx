import { redirect } from 'next/navigation';

export default function OperationsIndex() {
  redirect('/admin/operations/today');
}
