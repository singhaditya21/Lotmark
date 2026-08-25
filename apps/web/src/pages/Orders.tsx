import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toast';
import { api, ApiError, type OrdersView, type OrderRow } from '../lib/api';
import { Dialog, Field } from '../components/Dialog';

/**
 * Orders, dispatch and the cold chain.
 *
 * One screen for both halves again: a laboratory watching its own order move
 * and a dispatcher moving it are looking at the same rows. The server decides
 * which rows exist (`scope`) and what may be done to them (`canAdvance`).
 *
 * ── The transitions come from the server ────────────────────────────────────
 *
 * The buttons are rendered from the declared ORDER_MACHINE, sent with the
 * response. A console that hardcoded "placed → packed → dispatched" would drift
 * from the machine the server enforces, and the drift would appear as buttons
 * that 409.
 */
export function Orders() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [shipFor, setShipFor] = useState<OrderRow | null>(null);
  const [temperatureClass, setTemperatureClass] = useState('2-8');
  const [readingsFor, setReadingsFor] = useState<string | null>(null);
  const [readings, setReadings] = useState('');
  const [courier, setCourier] = useState('');

  const view = useQuery({
    queryKey: ['orders'],
    queryFn: () => api.get<OrdersView>('/orders'),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['capa'] });
    void qc.invalidateQueries({ queryKey: ['audit'] });
  };
  const onError = (e: unknown) =>
    setError(e instanceof ApiError ? e.problem.detail : 'That could not be completed.');

  const advance = useMutation({
    mutationFn: (a: { id: string; to: string }) =>
      api.post(`/orders/${a.id}/advance`, { to: a.to, courier: courier || undefined }),
    onSuccess: (_r, a) => { setError(null); setCourier(''); toast.success(`Order moved to ${a.to}.`); refresh(); },
    onError,
  });

  const createShipment = useMutation({
    mutationFn: () => api.post<{ code: string }>(`/orders/${shipFor!.id}/shipment`, { temperatureClass }),
    onSuccess: (r) => { setShipFor(null); setError(null); toast.success(`Shipment ${r.code} created.`); refresh(); },
    onError,
  });

  const addReadings = useMutation({
    mutationFn: () => api.post<{ excursions: number; capaRaised: string | null }>(
      `/shipments/${readingsFor}/readings`,
      {
        /**
         * One reading per line, "ISO instant, celsius". Deliberately plain
         * text: a logger export is a CSV and this is the shortest honest path
         * from one to the other without pretending to parse every vendor's
         * format.
         */
        readings: readings.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
          const [readAt, celsius] = line.split(',').map((p) => p.trim());
          return { readAt: readAt!, celsius: Number(celsius) };
        }),
      },
    ),
    onSuccess: (r) => {
      setReadingsFor(null); setReadings(''); setError(null);
      toast.success(
        r.excursions === 0
          ? 'Readings recorded — all within the temperature class.'
          : `${r.excursions} excursion(s) recorded. CAPA ${r.capaRaised} was raised automatically.`,
      );
      refresh();
    },
    onError,
  });

  const v = view.data;
  const nextStates = (from: string) =>
    (v?.transitions ?? []).filter((t) => t.from === from).map((t) => t.to);
  const linesOf = (orderId: string) => (v?.lines ?? []).filter((l) => l.order_id === orderId);
  const shipmentsOf = (orderId: string) => (v?.shipments ?? []).filter((s) => s.order_id === orderId);

  return (
    <>
      <h1>{v?.scope === 'own' ? 'My orders' : 'Orders and dispatch'}</h1>
      <p className="lede">
        {v?.scope === 'own'
          ? 'Your organisation’s orders. Nobody else’s are visible to you, and yours are not visible to them.'
          : 'Every order in the tenant, and the cold chain behind each shipment.'}
      </p>

      {error && <div className="note deny" role="alert">{error}</div>}

      {view.isLoading ? <div className="spinner">Loading…</div> : (v?.orders ?? []).length === 0 ? (
        <div className="note">No orders yet.</div>
      ) : (
        <div className="card" style={{ marginTop: 13 }}>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  {v?.scope === 'all' && <th>Laboratory</th>}
                  <th>Contents</th><th>State</th><th>Cold chain</th><th>Total</th><th />
                </tr>
              </thead>
              <tbody>
                {v!.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">
                      <b>{o.code}</b>
                      <div className="muted" style={{ fontSize: 11.5 }}>{o.placed_on}</div>
                    </td>
                    {v!.scope === 'all' && <td>{o.organisation_name}</td>}
                    <td className="muted" style={{ fontSize: 12.5 }}>
                      {linesOf(o.id).map((l) => (
                        <div key={l.lot_code}>{l.quantity}× {l.material_name} <span className="mono">{l.lot_code}</span></div>
                      ))}
                    </td>
                    <td>
                      <span className={`chip ${
                        o.state === 'delivered' ? 'ok' : o.state === 'cancelled' ? 'bad' : 'warn'}`}>
                        {o.state}
                      </span>
                      {o.courier && <div className="muted" style={{ fontSize: 11.5 }}>{o.courier}</div>}
                      {/* The tracking reference is the buyer's one handle on a
                          dispatched shipment; it is in the payload, so show it. */}
                      {o.tracking_reference && (
                        <div className="mono" style={{ fontSize: 11.5 }}>{o.tracking_reference}</div>
                      )}
                    </td>
                    <td>
                      {shipmentsOf(o.id).length === 0 ? <span className="muted">—</span>
                        : shipmentsOf(o.id).map((s) => (
                          <div key={s.id} style={{ marginBottom: 3 }}>
                            <span className="mono">{s.code}</span>{' '}
                            <span className={`chip ${s.excursions > 0 ? 'bad' : 'ok'}`}>
                              {s.excursions > 0 ? `${s.excursions} excursion(s)` : `${s.readings} reading(s)`}
                            </span>{' '}
                            {v!.canAdvance && (
                              <button className="btn ghost sm"
                                      onClick={() => { setReadingsFor(s.id); setError(null); }}>
                                readings
                              </button>
                            )}
                          </div>
                        ))}
                    </td>
                    <td className="mono">{(o.total_minor / 100).toFixed(2)} {o.currency}</td>
                    <td>
                      {v!.canAdvance && (
                        <div className="row">
                          {nextStates(o.state).map((to) => (
                            <button key={to} className={`btn sm ${to === 'cancelled' ? 'danger' : ''}`}
                                    disabled={advance.isPending}
                                    onClick={() => advance.mutate({ id: o.id, to })}>
                              {to}
                            </button>
                          ))}
                          {shipmentsOf(o.id).length === 0 && (
                            <button className="btn ghost sm"
                                    onClick={() => { setShipFor(o); setError(null); }}>
                              Ship
                            </button>
                          )}
                        </div>
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
        open={shipFor !== null}
        title={shipFor ? `Ship ${shipFor.code}` : ''}
        lede="The temperature class the shipment must hold. A reading outside it raises a CAPA automatically."
        onClose={() => setShipFor(null)}
        footer={<>
          <button className="btn" disabled={createShipment.isPending} onClick={() => createShipment.mutate()}>
            {createShipment.isPending ? 'Creating…' : 'Create shipment'}
          </button>
          <button className="btn ghost" onClick={() => setShipFor(null)}>Cancel</button>
        </>}
      >
        <Field label="Temperature class" hint="low-high in °C, e.g. 2-8">
          <input className="t mono" value={temperatureClass}
                 onChange={(e) => setTemperatureClass(e.target.value)} />
        </Field>
      </Dialog>

      <Dialog
        open={readingsFor !== null}
        title="Record logger readings"
        lede="Stored as data, not as an attached document — which is what lets an excursion raise a CAPA by itself rather than waiting for somebody to notice it in a chart."
        onClose={() => setReadingsFor(null)}
        footer={<>
          <button className="btn" disabled={addReadings.isPending || readings.trim().length === 0}
                  onClick={() => addReadings.mutate()}>
            {addReadings.isPending ? 'Recording…' : 'Record'}
          </button>
          <button className="btn ghost" onClick={() => setReadingsFor(null)}>Cancel</button>
        </>}
      >
        <Field label="Readings" hint="one per line: instant, °C">
          <textarea className="t mono" rows={6} value={readings}
                    onChange={(e) => setReadings(e.target.value)}
                    placeholder={'2026-08-20T08:00:00Z, 4.2\n2026-08-20T14:00:00Z, 5.1'} />
        </Field>
      </Dialog>
    </>
  );
}
