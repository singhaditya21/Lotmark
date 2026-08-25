import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Catalogue as CatalogueData, type CatalogueItem } from '../lib/api';
import { sig } from '../lib/format';
import { Dialog, Field } from '../components/Dialog';

/**
 * What can be bought.
 *
 * One screen serving both halves, because it is the same list — a laboratory
 * ordering from it and the producer pricing it are looking at exactly the same
 * material. What differs is what they can DO, and that comes from the server:
 * `canOrder` and `canManage` are computed there and re-checked on every act.
 *
 * A withdrawn lot is absent, not greyed out. Its certificate has been
 * withdrawn; there is nothing to explain and nothing to reconsider.
 */
export function Catalogue() {
  const qc = useQueryClient();
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [pricing, setPricing] = useState<CatalogueItem | null>(null);
  const [price, setPrice] = useState('');
  const [tierable, setTierable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const cat = useQuery({
    queryKey: ['catalogue'],
    queryFn: () => api.get<CatalogueData>('/catalogue'),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['catalogue'] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['audit'] });
  };
  const onError = (e: unknown) =>
    setError(e instanceof ApiError ? e.problem.detail : 'That could not be completed.');

  const order = useMutation({
    mutationFn: () => api.post<{ code: string; totalMinor: number }>('/orders', {
      lines: Object.entries(basket)
        .filter(([, q]) => q > 0)
        .map(([lotId, quantity]) => ({ lotId, quantity })),
    }),
    onSuccess: (r) => {
      setBasket({}); setError(null);
      // Currency as a code, never the ₹ glyph: this bundle is published
      // world-readable and scanned for it. Matches how Orders shows a total.
      setFlash(`Order ${r.code} placed — ${(r.totalMinor / 100).toFixed(2)} INR.`);
      refresh();
    },
    onError,
  });

  const setPriceOn = useMutation({
    mutationFn: () => api.put(`/catalogue/${pricing!.id}`, {
      unitPriceMinor: Math.round(Number(price) * 100),
      tierable,
    }),
    onSuccess: () => { setPricing(null); setError(null); setFlash('Price updated.'); refresh(); },
    onError,
  });

  const items = cat.data?.items ?? [];
  // Shelf life is load-bearing for a reference material, so it is flagged at the
  // point of purchase, not discovered after. `soon` is 90 days out — short-dated.
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
  const inBasket = Object.values(basket).reduce((n, q) => n + q, 0);
  const basketTotal = items.reduce((sum, i) => sum + (basket[i.id] ?? 0) * i.unit_price_minor, 0);

  return (
    <>
      <h1>Catalogue</h1>
      <p className="lede">
        Released lots with an authorised certified value. A lot whose
        certificate has been withdrawn is not here at all.
      </p>

      {flash && <div className="note okbox" aria-live="polite">{flash}</div>}
      {error && <div className="note deny" role="alert">{error}</div>}

      {cat.data?.canOrder && inBasket > 0 && (
        <div className="note info">
          <b>{inBasket} unit(s) selected · {(basketTotal / 100).toFixed(2)}</b>{' '}
          <button className="btn sm" disabled={order.isPending} onClick={() => order.mutate()}>
            {order.isPending ? 'Placing…' : 'Place order'}
          </button>{' '}
          <button className="btn ghost sm" onClick={() => setBasket({})}>Clear</button>
        </div>
      )}

      {cat.isLoading ? <div className="spinner">Loading…</div> : items.length === 0 ? (
        <div className="note">Nothing is currently released for sale.</div>
      ) : (
        <div className="card" style={{ marginTop: 13 }}>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Material</th><th>Lot</th><th>Certified value</th>
                  <th>Expires</th><th>Storage</th><th>Stock</th><th>Price</th><th />
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <b>{i.material_name}</b>
                      <div className="muted mono" style={{ fontSize: 11.5 }}>
                        {i.sku}{i.cas_number ? ` · CAS ${i.cas_number}` : ''}
                      </div>
                    </td>
                    <td className="mono">
                      {i.lot_code}
                      {i.certificate_code && (
                        <div className="muted" style={{ fontSize: 11.5 }}>{i.certificate_code}</div>
                      )}
                    </td>
                    <td className="mono">
                      {i.assigned_value === null ? '—' : (
                        <>
                          {sig(i.assigned_value, 7)} ± {sig(i.expanded_uncertainty, 4)} {i.unit}
                          <div className="muted" style={{ fontSize: 11.5 }}>{i.property_name}</div>
                        </>
                      )}
                    </td>
                    <td className="mono">
                      {i.expiry_date}
                      {i.expiry_date < today
                        ? <div><span className="chip bad">expired</span></div>
                        : i.expiry_date < soon
                          ? <div><span className="chip warn">short-dated</span></div>
                          : null}
                    </td>
                    <td>
                      {i.storage_condition}
                      {i.cold_chain && <span className="chip warn" style={{ marginLeft: 6 }}>cold chain</span>}
                    </td>
                    <td className="mono">{i.stock_units}</td>
                    <td className="mono">
                      {(i.unit_price_minor / 100).toFixed(2)}
                      {i.tierable && <div className="muted" style={{ fontSize: 11 }}>tier eligible</div>}
                    </td>
                    <td>
                      {cat.data?.canOrder && i.stock_units > 0 && (
                        <input
                          className="t mono" type="number" min={0} max={i.stock_units}
                          style={{ width: 76 }}
                          value={basket[i.id] ?? 0}
                          // `max` alone does not stop a typed value; clamp to
                          // stock so the basket, total and order can never claim
                          // more units than exist.
                          onChange={(e) => setBasket({
                            ...basket,
                            [i.id]: Math.min(i.stock_units, Math.max(0, Number(e.target.value))),
                          })}
                        />
                      )}
                      {cat.data?.canManage && (
                        <button className="btn ghost sm" onClick={() => {
                          setPricing(i);
                          setPrice((i.unit_price_minor / 100).toFixed(2));
                          setTierable(i.tierable);
                          setError(null);
                        }}>
                          Price
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Dialog
        open={pricing !== null}
        title={pricing ? `Price ${pricing.lot_code}` : ''}
        lede="Priced per unit. Changing it does not alter any order already placed."
        onClose={() => setPricing(null)}
        footer={<>
          <button className="btn" disabled={setPriceOn.isPending} onClick={() => setPriceOn.mutate()}>
            {setPriceOn.isPending ? 'Saving…' : 'Save'}
          </button>
          <button className="btn ghost" onClick={() => setPricing(null)}>Cancel</button>
        </>}
      >
        <div className="grid2">
          <Field label="Unit price">
            <input className="t mono" type="number" step="0.01" min="0"
                   value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
          <Field label="Government tier" hint="whether an approved tier claim may apply">
            <select className="t" value={tierable ? 'yes' : 'no'}
                    onChange={(e) => setTierable(e.target.value === 'yes')}>
              <option value="no">Not eligible</option>
              <option value="yes">Eligible</option>
            </select>
          </Field>
        </div>
        <div className="note warn">
          Marking a lot tier-eligible records eligibility and nothing more. There
          is no tier price list in the product, so an approved claim does not
          make anything cost less.
        </div>
      </Dialog>
    </>
  );
}
