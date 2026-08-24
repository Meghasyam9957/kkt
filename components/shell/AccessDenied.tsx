/**
 * What a signed-in person sees when a screen is not part of their role.
 *
 * It says so plainly rather than pretending the page does not exist. The visitor is
 * authenticated and their session is fine — implying otherwise would send an operations
 * manager hunting for a login problem they do not have.
 *
 * It names no figure, no record and no other role's data. The only thing it discloses is
 * that a screen exists which this role does not use, which the navigation already implies.
 */
import Link from 'next/link';
import { PageHeader, Section, Card, CardBody } from '@/components/ui/primitives';

export function AccessDenied({ role }: { role: string }) {
  return (
    <>
      <PageHeader
        title="Not available for your role"
        description="You are signed in. This screen is simply not part of what this role uses."
      />
      <Section>
        <Card>
          <CardBody>
            <p className="sv-denied__body">
              Your account has the <strong>{role.replace('_', ' ').toLowerCase()}</strong> role,
              which does not include this screen. Nothing has gone wrong with your session.
            </p>
            <p className="sv-denied__body">
              If you need access, ask an administrator to review your role — it is not
              something that can be granted from this page.
            </p>
            <p className="sv-denied__actions">
              {/* `/admin` resolves per role — for an investor "your dashboard" is the
                  portfolio, and linking to the financial dashboard from here was a loop
                  back into this very screen. */}
              <Link className="sv-btn sv-btn--secondary" href="/admin">Back to your dashboard</Link>
            </p>
          </CardBody>
        </Card>
      </Section>
    </>
  );
}
