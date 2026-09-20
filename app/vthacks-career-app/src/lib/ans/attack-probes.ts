/**
 * attack-probes.ts — the threat battery, as data (F7.10).
 *
 * The same probes as agents/attack-battery.mjs, defined so both the CLI and the
 * live console run one list rather than drifting into two. Each probe names the
 * threat class it stands for, because a blocked counter with no reasons is the
 * same mistake as a trust score with no reasons (hard rule 4).
 *
 * THE CONTROL PROBE IS NOT DECORATION. A gate that refuses everything is not a
 * gate, it is an outage. `expect: 'accept'` is what distinguishes the two, and a
 * run where the control fails is a FAILED run even if every attack was blocked.
 */

export type ProbeExpectation = 'accept' | 'block';

export type Probe = {
  id: string;
  label: string;
  /** The threat class, in the words the threat-model slide uses. */
  threat: string;
  expect: ProbeExpectation;
};

export const PROBES: Probe[] = [
  {
    id: 'control',
    label: 'Genuine signed application',
    threat: 'Control — the real path must still work.',
    expect: 'accept',
  },
  {
    id: 'unsigned',
    label: 'Unsigned application',
    threat: 'Anyone can POST JSON at a public endpoint.',
    expect: 'block',
  },
  {
    id: 'claimed-name',
    label: 'Claims our name, no signature',
    threat: 'Naming an ANS agent is not the same as being it.',
    expect: 'block',
  },
  {
    id: 'wrong-key',
    label: 'Impersonation with another ANS key',
    threat: 'A registered agent signing as a different one.',
    expect: 'block',
  },
  {
    id: 'role-swap',
    label: 'Employer agent applying as a candidate',
    threat: 'A real agent acting outside its registered role.',
    expect: 'block',
  },
  {
    id: 'unregistered',
    label: 'Sender not registered in ANS',
    threat: 'A signature proves a key, not a registration.',
    expect: 'block',
  },
  {
    id: 'lookalike',
    label: 'Lookalike registry name',
    threat: 'A near-miss name that reads correct to a human.',
    expect: 'block',
  },
  {
    id: 'replay',
    label: 'Replay of a genuine application',
    threat: 'A captured valid message, sent twice.',
    expect: 'block',
  },
  {
    id: 'wrong-audience',
    label: 'Addressed to a different employer',
    threat: 'A valid message redirected to another recipient.',
    expect: 'block',
  },
  {
    id: 'tampered',
    label: 'Contents rewritten after signing',
    threat: 'The envelope edited in flight.',
    expect: 'block',
  },
  {
    id: 'stale',
    label: 'Signed ten minutes ago',
    threat: 'An old message held and replayed later.',
    expect: 'block',
  },
  {
    id: 'future',
    label: 'Dated ten minutes ahead',
    threat: 'A clock-skew window held open deliberately.',
    expect: 'block',
  },
];

export type ProbeResult = Probe & {
  status: number;
  /** What the employer agent said, in its own words. */
  reason: string;
  /** Did the endpoint do what it should have? */
  correct: boolean;
};

/** A run is only a pass when every probe, control included, behaved correctly. */
export function summarize(results: ProbeResult[]) {
  const attacks = results.filter((result) => result.expect === 'block');
  const control = results.find((result) => result.expect === 'accept');
  return {
    blocked: attacks.filter((result) => result.correct).length,
    attacks: attacks.length,
    control_accepted: control?.correct ?? false,
    // Leaked = an attack the endpoint let through. The number that must be zero.
    leaked: attacks.filter((result) => !result.correct).length,
    passed: results.every((result) => result.correct),
  };
}
