/**
 * The four §11.50 meanings.
 *
 * Mirrors SIGNATURE_MEANINGS in @lotmark/domain. The console does not import
 * the domain package directly: these strings reach the browser as UI labels,
 * and the server validates every submitted meaning against its own list
 * regardless of what the client offers.
 */
export const ALL_MEANINGS = [
  ['authorship', 'Authorship — I produced this record'],
  ['review', 'Review — I have reviewed this record'],
  ['approval', 'Approval — I approve this record'],
  ['responsibility', 'Responsibility — I accept responsibility for this record'],
] as const;

export type Meaning = (typeof ALL_MEANINGS)[number][0];
