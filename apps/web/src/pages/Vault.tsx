import { useQuery } from '@tanstack/react-query';
import { api, type VaultView } from '../lib/api';
import { sig } from '../lib/format';

/**
 * The laboratory's own holdings, and the certificate behind each one.
 *
 * ── The two things this page exists to say ──────────────────────────────────
 *
 * WITHDRAWN, loudly. If a certificate covering material on these shelves has
 * been withdrawn, that is the single most important fact the laboratory can be
 * told, and it belongs where they look at the material rather than only in an
 * email they may have missed.
 *
 * And the verification address, because a certificate can be checked by anyone
 * holding it — no account with the producer required. That is deliberate: an
 * auditor examining a printed certificate must not need a login from the
 * organisation whose certificate is in question.
 */
export function Vault() {
  const vault = useQuery({
    queryKey: ['vault'],
    queryFn: () => api.get<VaultView>('/vault'),
  });

  const holdings = vault.data?.holdings ?? [];
  const withdrawn = holdings.filter((h) => h.withdrawn === true);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <h1>Certificate vault</h1>
      <p className="lede">
        Material held by {vault.data?.organisation ?? 'your organisation'}, with the
        certificate covering each lot. No other laboratory can see this, and you
        cannot see theirs.
      </p>

      {withdrawn.length > 0 && (
        <div className="note deny">
          <b>{withdrawn.length} of your holdings {withdrawn.length === 1 ? 'is' : 'are'} covered by a
          WITHDRAWN certificate.</b> Do not rely on {withdrawn.length === 1 ? 'it' : 'them'}.
          Contact the producer before using the material.
        </div>
      )}

      {vault.isLoading ? <div className="spinner">Loading…</div> : holdings.length === 0 ? (
        <div className="note">
          Nothing recorded in your vault yet. Material arrives here when an order
          is delivered, and can also be added for vials received as samples or
          replacements — which is why a withdrawal notice is not derived from
          orders alone.
        </div>
      ) : (
        <div className="card" style={{ marginTop: 13 }}>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Material</th><th>Lot</th><th>Certified value</th><th>Certificate</th>
                  <th>Units</th><th>Expires</th><th>Acquired</th><th>Verify</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <tr key={h.id} className={h.withdrawn ? 'bad-row' : undefined}>
                    <td>
                      <b>{h.material_name}</b>
                      {h.cas_number && (
                        <div className="muted mono" style={{ fontSize: 11.5 }}>CAS {h.cas_number}</div>
                      )}
                    </td>
                    <td className="mono">
                      {h.lot_code}
                      <div className="muted" style={{ fontSize: 11.5 }}>{h.storage_location ?? '—'}</div>
                    </td>
                    <td className="mono">
                      {h.assigned_value === null ? '—' : (
                        <>
                          {sig(h.assigned_value, 7)} ± {sig(h.expanded_uncertainty, 4)} {h.unit}
                          <div className="muted" style={{ fontSize: 11.5 }}>{h.property_name}</div>
                        </>
                      )}
                    </td>
                    <td>
                      {h.certificate_code ? (
                        <>
                          <span className="mono">{h.certificate_code}</span>
                          {' '}<span className="muted">#{h.issue_number}</span>
                          {h.withdrawn
                            ? <div><span className="chip bad">WITHDRAWN</span></div>
                            : <div><span className="chip ok">current</span></div>}
                        </>
                      ) : <span className="muted">none</span>}
                    </td>
                    <td className="mono">{h.quantity}</td>
                    <td className="mono">
                      {h.expiry_date}
                      {h.expiry_date < today && <div><span className="chip bad">expired</span></div>}
                    </td>
                    <td className="mono muted" style={{ fontSize: 12 }}>
                      {h.acquired_on}
                      {/*
                        How the date was arrived at. `earliest_possible` is a
                        lower bound rather than a date anybody recorded, and
                        saying so beats presenting it as a fact.
                      */}
                      {h.acquired_on_basis !== 'recorded' && (
                        <div style={{ fontSize: 11 }}>
                          {h.acquired_on_basis === 'derived_from_order'
                            ? 'from the order'
                            : 'earliest possible'}
                        </div>
                      )}
                    </td>
                    <td>
                      {h.verification_token ? (
                        <a className="mono" style={{ fontSize: 11.5 }}
                           href={`${vault.data!.verifyOrigin}/verify/${h.verification_token}`}
                           target="_blank" rel="noreferrer">
                          check
                        </a>
                      ) : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
        Every certificate can be checked without an account, by anyone holding
        it. An auditor examining a printed certificate should not need a login
        from the producer whose certificate is in question.
      </p>
    </>
  );
}
