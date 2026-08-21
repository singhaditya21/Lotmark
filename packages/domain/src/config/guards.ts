/**
 * Guards — the small language a tenant may use to condition a transition.
 *
 * ── Why this is a parser and not an expression evaluated by the host ────────
 *
 * `docs/architecture/LOW-CODE.md` already draws the line for reports:
 * "Configuration shapes and filters; it does not execute. A configuration
 * language that can run arbitrary SQL is a privilege-escalation path wearing a
 * report builder's clothes." A guard is the same hazard in a smaller costume.
 * Anything that reaches `eval`, `new Function`, a template engine or a SQL
 * string gives a person who can edit configuration the ability to run code as
 * the server — and editing configuration is `user:manage`, not root.
 *
 * So: a tokeniser, a recursive-descent parser producing a typed tree, and an
 * interpreter over that tree with no access to anything but the values it is
 * handed. There are no function calls, no loops and no recursion in the
 * grammar, so every guard terminates, and the only thing an author can express
 * is a question about facts already in front of them.
 *
 * ── What a guard may read ───────────────────────────────────────────────────
 *
 * A FACTS OBJECT THE ROUTE BUILDS. Not the database, not another record, not
 * the clock, not the actor. Each of those was considered and each is refused
 * for a reason:
 *
 *  · the database — a guard that can query is a report builder with a
 *    different name, and the tenant-isolation argument has to be made again
 *    for a second query path;
 *  · another record — the same, plus it makes a move's legality depend on rows
 *    the person cannot see;
 *  · the clock — a guard that reads time is not reproducible, and "why was this
 *    refused" stops being answerable from the record;
 *  · the actor — authority is what permissions, competence and segregation of
 *    duties decide. A guard that inspected the actor would be a second, weaker
 *    authorisation system beside the one that is audited.
 *
 * What is left is the record being moved and the custom fields on it, which is
 * exactly the class of rule people actually want: a Major nonconformity may not
 * close without a preventive action.
 *
 * ── Fail closed ─────────────────────────────────────────────────────────────
 *
 * A guard that does not parse, names a fact that does not exist, or compares
 * things that cannot be compared REFUSES the move. Never "assume true": a rule
 * nobody can evaluate is a rule that is not being applied, and the safe reading
 * of an unapplied rule is that the move is not allowed. Publication validates
 * every guard against the entity's vocabulary, so this should be unreachable
 * from the console — it is what catches an entry that arrived another way.
 */

export type GuardValue = string | number | boolean | null;

/**
 * `unknown` values, deliberately.
 *
 * The route hands over whatever the database gave it, and the evaluator checks
 * the type of everything it touches before doing anything with it — a value of
 * an unexpected shape compares equal to nothing, is not empty, and cannot be
 * ordered. Demanding the caller pre-narrow every column would move that check
 * to a place where forgetting it is possible.
 */
export interface GuardFacts {
  readonly [key: string]: unknown;
}

/* ── Tokens ───────────────────────────────────────────────────────────────── */

type Tok =
  | { k: 'path'; v: string }
  | { k: 'string'; v: string }
  | { k: 'number'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'op'; v: '==' | '!=' | '<' | '<=' | '>' | '>=' }
  | { k: 'word'; v: 'and' | 'or' | 'not' | 'is' | 'empty' }
  | { k: '(' } | { k: ')' };

export class GuardError extends Error {
  constructor(message: string, readonly at?: number) {
    super(message);
    this.name = 'GuardError';
  }
}

/** Bounded so a pathological expression cannot be written at all. */
export const MAX_GUARD_LENGTH = 400;

const WORDS = new Set(['and', 'or', 'not', 'is', 'empty', 'true', 'false', 'null']);

function tokenise(src: string): Tok[] {
  if (src.length > MAX_GUARD_LENGTH) {
    throw new GuardError(`a guard may be at most ${MAX_GUARD_LENGTH} characters`);
  }
  const out: Tok[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i]!;

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(') { out.push({ k: '(' }); i++; continue; }
    if (c === ')') { out.push({ k: ')' }); i++; continue; }

    // Two-character operators before one-character ones, or `<=` reads as `<`.
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
      out.push({ k: 'op', v: two }); i += 2; continue;
    }
    if (c === '<' || c === '>') { out.push({ k: 'op', v: c }); i++; continue; }
    if (c === '=' || c === '!') {
      throw new GuardError(`use '==' and '!=' for comparison (at ${i})`, i);
    }

    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end === -1) throw new GuardError(`unterminated string (at ${i})`, i);
      out.push({ k: 'string', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }

    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < src.length && /[0-9._-]/.test(src[j]!)) j++;
      const raw = src.slice(i, j);
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new GuardError(`'${raw}' is not a number (at ${i})`, i);
      out.push({ k: 'number', v: n });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j]!)) j++;
      const raw = src.slice(i, j);
      if (raw === 'true' || raw === 'false') out.push({ k: 'bool', v: raw === 'true' });
      else if (raw === 'null') out.push({ k: 'null' });
      else if (WORDS.has(raw)) out.push({ k: 'word', v: raw as 'and' });
      else out.push({ k: 'path', v: raw });
      i = j;
      continue;
    }

    throw new GuardError(`'${c}' cannot appear in a guard (at ${i})`, i);
  }

  return out;
}

/* ── The tree ─────────────────────────────────────────────────────────────── */

export type GuardNode =
  | { n: 'and'; left: GuardNode; right: GuardNode }
  | { n: 'or'; left: GuardNode; right: GuardNode }
  | { n: 'not'; on: GuardNode }
  | { n: 'compare'; op: '==' | '!=' | '<' | '<=' | '>' | '>='; left: Operand; right: Operand }
  | { n: 'empty'; of: Operand; negated: boolean }
  | { n: 'truthy'; of: Operand };

export type Operand =
  | { o: 'path'; path: string }
  | { o: 'literal'; value: GuardValue };

/**
 * Recursive descent, lowest precedence outermost: or → and → not → primary.
 *
 * No function-call production, and no way to write one: the only identifiers
 * the grammar admits are dotted paths, and a path is looked up, never invoked.
 */
export function parseGuard(src: string): GuardNode {
  const toks = tokenise(src);
  let p = 0;

  const peek = (): Tok | undefined => toks[p];
  const eat = (): Tok => {
    const t = toks[p++];
    if (!t) throw new GuardError('the guard ends before it is complete');
    return t;
  };
  const isWord = (w: string) => {
    const t = peek();
    return t !== undefined && t.k === 'word' && t.v === w;
  };

  function parseOr(): GuardNode {
    let left = parseAnd();
    while (isWord('or')) { eat(); left = { n: 'or', left, right: parseAnd() }; }
    return left;
  }

  function parseAnd(): GuardNode {
    let left = parseNot();
    while (isWord('and')) { eat(); left = { n: 'and', left, right: parseNot() }; }
    return left;
  }

  function parseNot(): GuardNode {
    if (isWord('not')) { eat(); return { n: 'not', on: parseNot() }; }
    return parsePrimary();
  }

  function parsePrimary(): GuardNode {
    const t = peek();
    if (t?.k === '(') {
      eat();
      const inner = parseOr();
      const close = eat();
      if (close.k !== ')') throw new GuardError('expected a closing bracket');
      return inner;
    }

    const left = parseOperand();

    const next = peek();
    if (next?.k === 'op') {
      eat();
      return { n: 'compare', op: next.v, left, right: parseOperand() };
    }
    if (next?.k === 'word' && next.v === 'is') {
      eat();
      let negated = false;
      if (isWord('not')) { eat(); negated = true; }
      const empty = eat();
      if (empty.k !== 'word' || empty.v !== 'empty') {
        throw new GuardError("expected 'empty' after 'is'");
      }
      return { n: 'empty', of: left, negated };
    }

    // A bare operand, which must turn out to be a boolean when evaluated.
    return { n: 'truthy', of: left };
  }

  function parseOperand(): Operand {
    const t = eat();
    switch (t.k) {
      case 'path': return { o: 'path', path: t.v };
      case 'string': return { o: 'literal', value: t.v };
      case 'number': return { o: 'literal', value: t.v };
      case 'bool': return { o: 'literal', value: t.v };
      case 'null': return { o: 'literal', value: null };
      default:
        throw new GuardError('expected a value or a field name');
    }
  }

  const tree = parseOr();
  if (p !== toks.length) throw new GuardError('the guard has something left over at the end');
  return tree;
}

/** Every fact a guard reads, for checking it against the vocabulary. */
export function pathsUsed(node: GuardNode): string[] {
  const out = new Set<string>();
  const operand = (o: Operand) => { if (o.o === 'path') out.add(o.path); };
  const walk = (n: GuardNode): void => {
    switch (n.n) {
      case 'and': case 'or': walk(n.left); walk(n.right); return;
      case 'not': walk(n.on); return;
      case 'compare': operand(n.left); operand(n.right); return;
      case 'empty': operand(n.of); return;
      case 'truthy': operand(n.of); return;
    }
  };
  walk(node);
  return [...out].sort();
}

/* ── Evaluation ───────────────────────────────────────────────────────────── */

/**
 * Walk the facts, and only the facts.
 *
 * OWN properties, checked with `hasOwnProperty` — not `in`, and not a plain
 * index. The first version indexed straight into the object, and a test written
 * to prove it could not escape proved the opposite: `record.__proto__` resolved
 * to `Object.prototype` and `record.constructor.name` to the string 'Object'.
 * Nothing could be written or called through that — the grammar has no
 * assignment and no call — but "a guard reads only what the route handed it"
 * was not true, and a claim about a sandbox has to be true rather than nearly.
 *
 * `Object.create(null)` for the facts would also have worked and would have
 * pushed the obligation onto every caller that builds one. This puts it here,
 * where it cannot be forgotten.
 */
function lookup(facts: GuardFacts, path: string): unknown {
  let cur: unknown = facts;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * Evaluate, or throw.
 *
 * Throwing rather than returning false, so a caller cannot mistake "this rule
 * says no" for "this rule could not be read". They mean different things to the
 * person who has to fix it, and only one of them is their fault.
 */
export function evaluateGuard(node: GuardNode, facts: GuardFacts): boolean {
  const value = (o: Operand): unknown =>
    (o.o === 'literal' ? o.value : lookup(facts, o.path));

  switch (node.n) {
    case 'and': return evaluateGuard(node.left, facts) && evaluateGuard(node.right, facts);
    case 'or': return evaluateGuard(node.left, facts) || evaluateGuard(node.right, facts);
    case 'not': return !evaluateGuard(node.on, facts);

    case 'empty': {
      const e = isEmpty(value(node.of));
      return node.negated ? !e : e;
    }

    case 'truthy': {
      const v = value(node.of);
      if (typeof v !== 'boolean') {
        throw new GuardError(
          `'${node.of.o === 'path' ? node.of.path : String(v)}' is not a yes/no value, ` +
          'so it cannot be used on its own — compare it to something.',
        );
      }
      return v;
    }

    case 'compare': {
      const l = value(node.left);
      const r = value(node.right);

      if (node.op === '==' || node.op === '!=') {
        // Undefined and null are the same absence as far as a guard is
        // concerned; a field nobody filled in and a field with no value are not
        // a distinction an author should have to know about.
        const same = (l ?? null) === (r ?? null);
        return node.op === '==' ? same : !same;
      }

      /**
       * Ordering compares numbers with numbers and strings with strings, and
       * nothing else. Comparing a number to a string in a language without
       * types is where "10" < "9" comes from, and a rule that is silently
       * wrong is worse than one that refuses.
       */
      if (typeof l === 'number' && typeof r === 'number') {
        return node.op === '<' ? l < r : node.op === '<=' ? l <= r
          : node.op === '>' ? l > r : l >= r;
      }
      if (typeof l === 'string' && typeof r === 'string') {
        // Lexicographic, which is what ISO dates want and is the only reason
        // string ordering is admitted at all.
        return node.op === '<' ? l < r : node.op === '<=' ? l <= r
          : node.op === '>' ? l > r : l >= r;
      }
      throw new GuardError(
        `cannot compare ${describe(l)} with ${describe(r)} using '${node.op}'`,
      );
    }
  }
}

function describe(v: unknown): string {
  if (v === undefined || v === null) return 'nothing';
  if (typeof v === 'string') return `the text '${v}'`;
  if (typeof v === 'number') return `the number ${v}`;
  if (typeof v === 'boolean') return `${v}`;
  return 'a value of a kind a guard cannot compare';
}

/* ── What each entity offers ──────────────────────────────────────────────── */

/**
 * The facts a guard may name, per entity.
 *
 * A closed list, and the route builds an object with exactly these keys. An
 * author cannot reach anything else because there is nothing else in the object
 * — the vocabulary is what publication checks against, not what confines
 * evaluation. Both layers exist: the list refuses a guard that names something
 * absent, and evaluation of an absent path yields `undefined`, which compares
 * equal to nothing and is empty.
 *
 * `custom.*` is deliberately open-ended: custom fields are the tenant's own, and
 * which exist is itself configuration. Publication checks those against the
 * fields the same version declares.
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

export interface GuardProblem { readonly guard: string; readonly message: string }

/**
 * Check a guard before it is published, against the entity's vocabulary and the
 * custom fields the same version declares.
 */
export function guardProblems(
  guard: string,
  entity: string,
  customFieldKeys: readonly string[],
): GuardProblem[] {
  let tree: GuardNode;
  try {
    tree = parseGuard(guard);
  } catch (e) {
    return [{ guard, message: e instanceof Error ? e.message : 'could not be read' }];
  }

  const allowed = new Set((GUARD_FACTS[entity] ?? []).map((f) => `record.${f}`));
  for (const k of customFieldKeys) allowed.add(`custom.${k}`);

  const problems: GuardProblem[] = [];
  for (const path of pathsUsed(tree)) {
    if (allowed.has(path)) continue;
    const known = [...allowed].sort();
    problems.push({
      guard,
      message: `'${path}' is not something a guard on ${entity} can read. `
        + `Available: ${known.join(', ') || 'nothing'}.`,
    });
  }
  return problems;
}
