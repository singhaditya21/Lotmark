/**
 * Golden tests against the prototype.
 *
 * prototype-golden.json was produced by executing the ORIGINAL functions from
 * docs/artefacts/lotmark-app.html over its own seed data. These tests assert
 * that the TypeScript reimplementation reproduces those numbers exactly, so the
 * move off the single-file prototype cannot silently change an assigned value
 * or an uncertainty budget.
 *
 * Regenerate only with a deliberate, documented decision — a changed number
 * here means every certificate computed under the old code is now unreproducible.
 */
import { describe, it, expect } from 'vitest';
import golden from './prototype-golden.json' with { type: 'json' };
import { oneWayAnova, type HomogeneityMeasurement } from '../homogeneity.js';
import { linearStability, shelfLifeMonthsBetween, type StabilityPoint } from '../stability.js';
import { consensus, type CharacterisationResult } from '../characterisation.js';
import { combineBudget, type UncertaintyComponent, type StudyType } from '../budget.js';

type RawRow = { u?: number; r?: number; m?: number; lab?: string; v: number };
type StudyMeta = { id: string; prj: string; type: string; state: string; at: string | null; shelf?: string };

const results = golden.results as Record<string, RawRow[]>;
const studyMeta = golden.studyMeta as StudyMeta[];
const TODAY = golden.today;

const asHomogeneity = (rows: RawRow[]): HomogeneityMeasurement[] =>
  rows.map((r) => ({ unit: r.u!, replicate: r.r!, value: r.v }));
const asStability = (rows: RawRow[]): StabilityPoint[] =>
  rows.map((r) => ({ months: r.m!, value: r.v }));
const asCharacterisation = (rows: RawRow[]): CharacterisationResult[] =>
  rows.map((r) => ({ laboratory: r.lab!, value: r.v }));

/** Exact float equality. These must not drift by even an ULP. */
const exactly = (actual: number, expected: number, label: string) => {
  expect(actual, label).toBe(expected);
};

describe('homogeneity — one-way ANOVA reproduces the prototype', () => {
  const cases = studyMeta.filter((s) => s.type === 'homogeneity');
  it.each(cases.map((s) => [s.id] as const))('%s', (id) => {
    const g = (golden.studies as Record<string, { stats: Record<string, number | boolean> }>)[id]!.stats;
    const r = oneWayAnova(asHomogeneity(results[id]!));
    exactly(r.units, g.units as number, `${id} units`);
    exactly(r.replicatesPerUnit, g.reps as number, `${id} reps`);
    exactly(r.grandMean, g.gm as number, `${id} grand mean`);
    exactly(r.msBetween, g.msB as number, `${id} MS between`);
    exactly(r.msWithin, g.msW as number, `${id} MS within`);
    exactly(r.uBb, g.ubb as number, `${id} u(bb)`);
    expect(r.floored, `${id} floored`).toBe(g.floored as boolean);
  });
});

describe('stability — regression reproduces the prototype', () => {
  const cases = studyMeta.filter((s) => s.type === 'stability');
  it.each(cases.map((s) => [s.id] as const))('%s', (id) => {
    const meta = studyMeta.find((s) => s.id === id)!;
    const g = (golden.studies as Record<string, { stats: Record<string, number | boolean> }>)[id]!.stats;
    const months = meta.shelf
      ? shelfLifeMonthsBetween(meta.at ?? TODAY, meta.shelf)
      : 24;
    exactly(months, g.shelfMonths as number, `${id} shelf months`);
    const r = linearStability(asStability(results[id]!), months);
    exactly(r.n, g.n as number, `${id} n`);
    exactly(r.slope, g.slope as number, `${id} slope`);
    exactly(r.intercept, g.inter as number, `${id} intercept`);
    exactly(r.slopeStandardError, g.seSlope as number, `${id} SE(slope)`);
    exactly(r.uLts, g.ults as number, `${id} u(lts)`);
    expect(r.trendSignificant, `${id} significance`).toBe(g.significant as boolean);
  });
});

describe('characterisation — consensus reproduces the prototype', () => {
  const cases = studyMeta.filter(
    (s) => s.type === 'characterisation' || s.type === 'confirmatory retest',
  );
  it.each(cases.map((s) => [s.id] as const))('%s', (id) => {
    const g = (golden.studies as Record<string, { stats: Record<string, number> }>)[id]!.stats;
    const r = consensus(asCharacterisation(results[id]!));
    exactly(r.laboratories, g.labs!, `${id} labs`);
    exactly(r.value, g.value!, `${id} consensus value`);
    exactly(r.standardDeviation, g.s!, `${id} s`);
    exactly(r.uChar, g.uchar!, `${id} u(char)`);
  });
});

describe('uncertainty budget reproduces the prototype', () => {
  const projects = Object.keys(golden.projects as Record<string, unknown>);
  it.each(projects.map((p) => [p] as const))('%s', (prjId) => {
    const g = (golden.projects as Record<string, {
      budget: { uBb: number | null; uLts: number | null; uChar: number | null; uc: number | null; complete: boolean };
      assignedValue: number | null;
    }>)[prjId]!;

    // Only SIGNED studies contribute — the same filter the prototype applied.
    const signed = studyMeta.filter((s) => s.prj === prjId && s.state === 'signed');
    const components: UncertaintyComponent[] = [];

    for (const s of signed) {
      const rows = results[s.id];
      if (!rows || rows.length === 0) continue;
      if (s.type === 'homogeneity') {
        components.push({
          studyId: s.id, studyType: 'homogeneity', symbol: 'u(bb)',
          value: oneWayAnova(asHomogeneity(rows)).uBb, basis: '',
        });
      } else if (s.type === 'stability') {
        const months = s.shelf ? shelfLifeMonthsBetween(s.at ?? TODAY, s.shelf) : 24;
        components.push({
          studyId: s.id, studyType: 'stability', symbol: 'u(lts)',
          value: linearStability(asStability(rows), months).uLts, basis: '',
        });
      } else if (s.type === 'characterisation') {
        components.push({
          studyId: s.id, studyType: 'characterisation', symbol: 'u(char)',
          value: consensus(asCharacterisation(rows)).uChar, basis: '',
        });
      }
    }

    const b = combineBudget(components);
    expect(b.uBb, `${prjId} u(bb)`).toBe(g.budget.uBb);
    expect(b.uLts, `${prjId} u(lts)`).toBe(g.budget.uLts);
    expect(b.uChar, `${prjId} u(char)`).toBe(g.budget.uChar);
    expect(b.uCombined, `${prjId} u_c`).toBe(g.budget.uc);
    expect(b.complete, `${prjId} complete`).toBe(g.budget.complete);

    // The assigned value is the characterisation consensus mean, never typed.
    const charStudy = signed.find((s) => s.type === 'characterisation');
    const assigned = charStudy && results[charStudy.id]
      ? consensus(asCharacterisation(results[charStudy.id]!)).value
      : null;
    expect(assigned, `${prjId} assigned value`).toBe(g.assignedValue);
  });
});
