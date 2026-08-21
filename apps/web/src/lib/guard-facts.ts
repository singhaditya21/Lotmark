/**
 * What a guard may read, for showing an author while they write one.
 *
 * A COPY of `GUARD_FACTS` in @lotmark/domain, and deliberately so: this app has
 * no dependency on the domain package — `surfaces.test.ts` re-declares persona
 * permissions as literal strings and says why. Taking one for a hint would pull
 * the whole domain into the browser bundle.
 *
 * Copying is safe HERE and would not be elsewhere, because this list is not a
 * control. It decides what a helpful note says; publication decides what is
 * allowed, from the server's own list, and refuses anything this one got wrong.
 * The failure mode of drift is a hint that omits a usable fact — annoying, and
 * not a way to get a bad guard published.
 */
export const GUARD_FACTS: Readonly<Record<string, readonly string[]>> = {
  capa: ['severity', 'source', 'root_cause', 'corrective_action',
    'preventive_action', 'effectiveness_check'],
  lot: ['storage_condition', 'cold_chain', 'stock_units', 'unit_price_minor', 'expiry_date'],
  order: ['total_minor', 'currency', 'courier', 'tracking_reference'],
  property_value: ['property_name', 'unit', 'assigned_value', 'expanded_uncertainty'],
  project: ['material_name', 'cas_number', 'sku'],
  study: ['study_type', 'uncertainty'],
  entitlement: ['tier'],
};
