/**
 * The API client.
 *
 * Everything goes through the same-origin `/api` proxy, so the session cookie
 * travels without any SameSite relaxation and development behaves the way
 * production will.
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  /** The ledger entry that recorded this refusal, where one was written. */
  auditSeq?: string;
  /** Field-level detail, for inline display on a form. */
  errors?: Array<{ field: string; message: string }>;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly problem: Problem) {
    super(problem.detail);
    this.name = 'ApiError';
  }

  /**
   * The server is asking for a step-up before this act may proceed.
   *
   * Branches on `code`, NOT on `title`. The server builds a problem's title by
   * humanising its code, so this compared 'Step up required' against
   * 'step_up_required' and was therefore always false — which meant the console
   * never opened the re-authentication dialog for ANY signed act. Signing a
   * study, assigning a value, authorising one and issuing a certificate all
   * dead-ended the first time in a session, showing the user a red message
   * telling them to re-enter credentials with nothing to enter them into.
   *
   * `code` exists precisely so a client can branch without parsing prose. This
   * is what happens when it parses the prose instead.
   */
  get needsStepUp(): boolean {
    return this.status === 401 && this.problem.code === 'step_up_required';
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** Field-level errors, for rendering inline on a form. */
  get fieldErrors(): Array<{ field: string; message: string }> {
    return this.problem.errors ?? [];
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  // An empty content-type means "send none at all" — see api.del.
  if (headers['content-type'] === '') delete headers['content-type'];

  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'same-origin',
    headers,
  });

  if (!res.ok) {
    let problem: Problem = {
      type: 'about:blank', title: String(res.status), status: res.status,
      detail: res.statusText, code: 'unknown',
    };
    try {
      const body = await res.json();
      if (body && typeof body === 'object' && 'detail' in body) problem = body as Problem;
      else if (body && typeof body === 'object' && 'message' in body) {
        problem = {
          type: 'about:blank', title: String(res.status), status: res.status,
          detail: String(body.message), code: 'unknown',
        };
      }
    } catch { /* the body was not JSON; the status line is all we have */ }
    throw new ApiError(res.status, problem);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  /**
   * DELETE with no body, and NO content-type header.
   *
   * Fastify refuses a request that declares `application/json` and then sends
   * nothing — `FST_ERR_CTP_EMPTY_JSON_BODY`, a 400 that looks like a routing
   * fault. The header is stripped rather than the body faked, because sending
   * `{}` would mean this client cannot tell "no body" from "an empty object".
   */
  del: <T>(path: string) =>
    request<T>(path, { method: 'DELETE', headers: { 'content-type': '' } }),
};

/* ── Shapes returned by the API ─────────────────────────────────────────── */

export interface Me {
  user: { id: string; name: string; email: string };
  /**
   * Which half of the product this person belongs in, from their ROLE kinds.
   *
   * Distinct from `organisation.kind` below, deliberately: role kind is the
   * product boundary (which half you land in), organisation kind is the data
   * boundary (which rows you may see, enforced by row-level security). A
   * producer employee holding a customer role for testing belongs in the
   * storefront; a laboratory user granted audit:read does not.
   */
  roleKinds: Array<'producer' | 'customer'>;
  organisation: { id: string; kind: string; name: string };
  teams: Array<{ id: string; key: string; name: string }>;
  permissions: string[];
  permissionsByTeam: Record<string, string[]>;
  secondFactorSatisfied: boolean;
}

export interface Project {
  id: string; code: string; material: string;
  cas: string | null; sku: string; stage: string; team: string | null;
}

export interface Study {
  id: string; code: string; type: string; state: string;
  uncertainty: number | null; signedOn: string | null;
}

export interface PropertyValue {
  id: string; code: string; property_name: string; unit: string; state: string;
  assigned_value: number | null; expanded_uncertainty: number | null;
  coverage_factor: number; assigned_by: string | null; authorised_by: string | null;
}

export interface Lot {
  id: string; lot_code: string; state: string; expiry_date: string;
  stock_units: number; storage_condition: string; cold_chain: boolean;
  supersedes: string | null; certificate_code: string | null;
  /** Needed to open the issue history; a UI must never derive an id from a code. */
  certificate_id: string | null;
}

export interface BudgetComponent {
  studyId: string; studyType: string; symbol: string; value: number; basis: string;
}

export interface Budget {
  project: { id: string; code: string };
  assignedValue: number | null;
  budget: {
    uBb: number | null; uLts: number | null; uChar: number | null;
    uCombined: number | null; complete: boolean;
    expanded: number | null; coverageFactor: number;
  };
  components: BudgetComponent[];
}

export interface Capa {
  id: string;
  code: string;
  source: string;
  severity: 'Minor' | 'Major' | 'Critical';
  state: CapaState;
  raised_on: string;
  due_on: string | null;
  root_cause: string | null;
  corrective_action: string | null;
  closed_at: string | null;
  team: string | null;
  /**
   * Supplied by the server from the declared state machine.
   *
   * The console renders these rather than deciding for itself what may follow
   * what — a hardcoded workflow in the UI would drift from the one actually
   * enforced, and the drift would show up as buttons that 409.
   */
  availableTransitions: CapaState[];
}

export type CapaState =
  | 'open' | 'investigation' | 'root_cause' | 'capa' | 'effectiveness' | 'closed';

export interface CapaWorkflow {
  states: CapaState[];
  initial: CapaState;
  terminal: CapaState[];
  transitions: Array<{ from: CapaState; to: CapaState; action: string; requires: string }>;
}

export interface AuditEntry {
  seq: string; occurred_at: string; actor_label: string; actor_role_id: string;
  kind: string; action: string; detail: string; time_source: string; region: string;
}

export interface ChainResult {
  ok: boolean;
  entries: number;
  brokenAt: number | null;
  reason: string | null;
  /** Which audit key generations the checked range spans. */
  generations: string[];
  /**
   * Generations whose key the server does not hold.
   *
   * Non-empty means the answer is "not checked", NOT "tampered with". The two
   * call for opposite responses — find a key, versus investigate a breach — so
   * the console must never render one as the other.
   */
  keysMissing: string[];
  unverified: boolean;
}

/* ── Certificates ───────────────────────────────────────────────────────── */

export interface CertificateIssue {
  number: number;
  issuedAt: string;
  issuedBy: string | null;
  reissueReason: string | null;
  withdrawn: boolean;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  propertyName: string;
  assignedValue: number;
  expandedUncertainty: number;
  coverageFactor: number;
  unit: string;
  documentSha256: string | null;
  verificationToken: string | null;
}

export interface CertificateDetail {
  certificate: { id: string; code: string; lotId: string; lotCode: string; lotState: string };
  /**
   * The highest issue that has not been withdrawn, or null.
   *
   * Null is a real state, not an error: withdrawing the latest issue leaves a
   * certificate with nothing current, which is precisely what a holder needs
   * to be told and is different from the document merely being superseded.
   */
  currentIssue: number | null;
  issues: CertificateIssue[];
}

export interface Holder {
  organisationId: string;
  organisation: string;
  quantity: number;
  basis: string;
  /**
   * Whether a notice would actually reach somebody.
   *
   * Computed by the server using the same function that addresses the notices —
   * an organisation with no named contact is still reachable if anyone there
   * has an active account. Deriving this in the browser from "is there a
   * contact" reported laboratories as unreachable that were about to be
   * notified perfectly well.
   */
  reachable: boolean;
  contactUserId?: string;
}

export interface HoldersResponse {
  holders: Holder[];
  /** Holders nobody could be addressed at — the ones needing another channel. */
  unreachableCount: number;
  /** False when the caller lacks 'pii:contact'; the list is still complete. */
  contactsVisible: boolean;
}

/**
 * Notification outcomes are reported as TWO lists and never as one total.
 *
 * A withdrawal notice that reached nobody, counted as delivered, is exactly the
 * failure the withdrawal exists to prevent. The server keeps them apart; so
 * does every screen that renders them.
 */
export interface NotifiedParty {
  organisation: string;
  basis: string;
  quantity?: number;
}

export interface ReissueResult {
  certificate: string;
  issue: { number: number; previous: number };
  changed: string[];
  changeSummary: string;
  document: { sha256: string; verifyUrl: string };
  notified: NotifiedParty[];
  unreachable: NotifiedParty[];
}

export interface WithdrawResult {
  certificate: string;
  issue: number;
  withdrawn: boolean;
  notified: NotifiedParty[];
  unreachable: NotifiedParty[];
}

/* ── Administration ─────────────────────────────────────────────────────── */

export type ConfigRisk = 'security' | 'behaviour' | 'presentation';

export interface ConfigChange {
  kind: string;
  key: string;
  change: 'added' | 'removed' | 'modified';
  risk: ConfigRisk;
}

export interface ConfigOverview {
  versions: Array<{
    id: string; number: number; status: 'draft' | 'active' | 'superseded';
    reason: string; publishedAt: string | null; signed: boolean; changeCount: number;
  }>;
  activeId: string | null;
  draftId: string | null;
  /** Per kind: its risk class, and whether publishing a change to it needs signing. */
  kinds: Record<string, { risk: ConfigRisk; signed: boolean }>;
}

export interface ConfigVersionDetail {
  version: {
    id: string; number: number; status: string; reason: string;
    basedOn: string | null; publishedAt: string | null; signed: boolean;
    changeSummary: ConfigChange[];
  };
  entries: Array<{ kind: string; key: string; payload: unknown; overridesDefault: boolean }>;
}

export interface ConfigReview {
  changes: ConfigChange[];
  /**
   * Everything that would stop this being published, not just the first thing.
   * An administrator fixing one problem at a time through a screen that reveals
   * the next one is how a configuration change takes an afternoon.
   */
  problems: string[];
  needsSignature: boolean;
  publishable: boolean;
}

export interface PersonRow {
  id: string; code: string; email: string; display_name: string;
  deactivated_at: string | null; mfa_enrolled: boolean;
  organisation_id: string; organisation_name: string; organisation_kind: string;
}

export interface AssignmentRow {
  id: string; user_id: string; role_key: string; team_id: string | null;
  valid_from: string | null; valid_to: string | null;
  granted_reason: string | null; team_name: string | null;
}

export interface TeamRow {
  id: string; key: string; name: string; description: string | null;
  archived_at: string | null; members: number;
}

export interface CompetenceRow {
  id: string; user_id: string; activity: string;
  valid_from: string; valid_to: string; basis: string | null; code: string;
}

export interface Directory {
  users: PersonRow[];
  assignments: AssignmentRow[];
  teams: TeamRow[];
  memberships: Array<{ id: string; team_id: string; user_id: string; joined_on: string }>;
  organisations: Array<{ id: string; name: string; kind: string }>;
  competence: CompetenceRow[];
  /** From the ACTIVE configuration, not from code — see admin-people.ts. */
  roles: Array<{ key: string; name: string; kind: string; permissions: string[] }>;
  competenceActivities: string[];
}

export interface NewUserResult {
  userId: string;
  /** Shown once, never recoverable, and deliberately not in the audit ledger. */
  initialPassword: string;
  enrolment: string;
  note: string;
}

/* ── Operations ─────────────────────────────────────────────────────────── */

export type JobState = 'healthy' | 'running' | 'failing' | 'stale' | 'never_run';

export interface JobStatus {
  name: string;
  description: string;
  cron: string;
  state: JobState;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastOutcome: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  hoursSinceSuccess: number | null;
  expectedEveryHours: number;
  /** What to do about it, when there is something to do. */
  advice: string | null;
}

export interface DrillRecord {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  source: string;
  outcome: string | null;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  notes: string | null;
}

export interface OpsReport {
  jobs: JobStatus[];
  /** Names of jobs an operator should act on. */
  attention: string[];
  drills: DrillRecord[];
  /** What these checks cannot see, stated rather than implied. */
  limits: string[];
}

/* ── Commerce ───────────────────────────────────────────────────────────── */

export interface CatalogueItem {
  id: string;
  lot_code: string;
  expiry_date: string;
  stock_units: number;
  storage_condition: string;
  cold_chain: boolean;
  unit_price_minor: number;
  tierable: boolean;
  material_name: string;
  cas_number: string | null;
  sku: string;
  certificate_code: string | null;
  assigned_value: number | null;
  expanded_uncertainty: number | null;
  unit: string | null;
  property_name: string | null;
}

export interface Catalogue {
  items: CatalogueItem[];
  canManage: boolean;
  canOrder: boolean;
}

export interface OrderRow {
  id: string;
  code: string;
  state: string;
  placed_on: string;
  total_minor: number;
  currency: string;
  courier: string | null;
  tracking_reference: string | null;
  organisation_name: string;
}

export interface OrderLine {
  order_id: string;
  quantity: number;
  unit_price_minor: number;
  lot_code: string;
  material_name: string;
}

export interface ShipmentRow {
  id: string;
  order_id: string;
  code: string;
  temperature_class: string;
  dispatched_at: string | null;
  delivered_at: string | null;
  readings: number;
  excursions: number;
}

export interface OrdersView {
  orders: OrderRow[];
  lines: OrderLine[];
  shipments: ShipmentRow[];
  /** 'all' for the producer, 'own' for a laboratory. */
  scope: 'all' | 'own';
  canAdvance: boolean;
  /** From the declared state machine, so the console never offers a 409. */
  transitions: Array<{ from: string; to: string; action: string }>;
}

export interface EntitlementRow {
  id: string;
  code: string;
  state: string;
  raised_on: string;
  supporting_document: string;
  decision_note: string | null;
  decided_at: string | null;
  revalidation_due: string | null;
  organisation_name: string;
  raised_by_name: string | null;
}

export interface EntitlementsView {
  claims: EntitlementRow[];
  canDecide: boolean;
  canClaim: boolean;
  /**
   * True, and stated rather than implied: an approved tier is RECORDED and
   * changes no price. No tier price list exists in the product.
   */
  tierHasNoPriceEffect: boolean;
}

export interface VaultHolding {
  id: string;
  quantity: number;
  storage_location: string | null;
  source: string;
  acquired_on: string;
  acquired_on_basis: string;
  lot_code: string;
  expiry_date: string;
  storage_condition: string;
  lot_state: string;
  material_name: string;
  cas_number: string | null;
  certificate_id: string | null;
  certificate_code: string | null;
  issue_number: number | null;
  withdrawn: boolean | null;
  verification_token: string | null;
  assigned_value: number | null;
  expanded_uncertainty: number | null;
  unit: string | null;
  property_name: string | null;
}

export interface VaultView {
  holdings: VaultHolding[];
  organisation: string;
  verifyOrigin: string;
}

/* ── Conformance ────────────────────────────────────────────────────────── */

export type RequirementStatus = 'enforced' | 'partial' | 'declared' | 'not_implemented';

export interface LiveEvidence {
  key: string;
  summary: string;
  figures: Record<string, string | number | null>;
  /** Whether the RECORDS support the claim right now. */
  satisfied: boolean;
}

export interface ConformanceRequirement {
  id: string;
  clause: string;
  statement: string;
  status: RequirementStatus;
  note?: string;
  code: string[];
  tests: Array<{ file: string; named: string }>;
  evidence: LiveEvidence | null;
}

export interface ClauseView {
  clause: string;
  requirements: ConformanceRequirement[];
  /** The weakest status among them — a clause is only as good as its worst part. */
  status: RequirementStatus;
}

export interface ConformanceView {
  clauses: ClauseView[];
  summary: { clauses: number; enforced: number; weaker: number };
}
