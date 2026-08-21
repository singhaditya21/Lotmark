import { whyNoSurface, permissionsThatWouldHelp, type Viewer } from '../lib/surfaces';

/**
 * What somebody sees when there is nothing for them to open.
 *
 * Four of the nine seeded personas reach this today. Previously they were shown
 * the Projects table, which returned zero rows because they legitimately have
 * visibility of no projects — a correct authorisation decision rendered as a
 * product that appears to have lost their data.
 *
 * The three cases are genuinely different and are told apart, because the
 * action each calls for is different: ask an administrator, wait for a release,
 * or get a role at all. Saying "no access" to all three would be true and
 * useless.
 */
export function Access({ viewer, name, organisation }: {
  viewer: Viewer;
  name: string;
  organisation: { kind: string; name: string };
}) {
  const reason = whyNoSurface(viewer);
  const half = viewer.roleKinds[0];

  return (
    <div className="card pad" style={{ maxWidth: 680 }}>
      <h1 style={{ marginTop: 0 }}>Nothing is open to you yet</h1>

      <p className="lede">
        You are signed in as <b>{name}</b> at {organisation.name}. Your account is
        working — there is simply no section of Lotmark you can open.
      </p>

      {reason === 'no_role' && (
        <>
          <div className="note warn">
            You hold no role, so you belong to neither half of the product.
          </div>
          <p>
            A tenant administrator needs to assign you a role, scoped either to a team
            or across the producer. Until then nothing here will show you anything,
            and that is the system working rather than failing.
          </p>
        </>
      )}

      {reason === 'half_not_built' && (
        <>
          <div className="note info">
            {half === 'customer'
              ? 'The laboratory half of Lotmark — ordering, entitlements and your certificate vault — is not part of this release.'
              : 'No section of the producer console is part of this release yet.'}
          </div>
          <p>
            Your role and permissions are correct and will keep working. There is
            nothing to grant and nothing to fix; the screens simply do not exist
            yet.{' '}
            {half === 'customer' && (
              <>
                In the meantime, a certificate you have been given can be checked without
                an account at all — every certificate carries a verification address that
                states whether that issue is current, superseded or withdrawn.
              </>
            )}
          </p>
        </>
      )}

      {reason === 'no_permissions' && (
        <>
          <div className="note warn">
            Sections exist for your role, but you hold none of the permissions that open
            them.
          </div>
          <p>
            Ask a tenant administrator for one of these, scoped to the team you work in:
          </p>
          <ul className="plain">
            {permissionsThatWouldHelp(viewer).map((p) => (
              <li key={p}><span className="mono">{p}</span></li>
            ))}
          </ul>
        </>
      )}

      <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
        Every action in Lotmark is authorised on its own terms when you take it. This
        page reflects what you hold right now; it will change the moment your roles do.
      </p>
    </div>
  );
}
