'use client';

import { useId, useState } from 'react';
import { Loader2, Search } from 'lucide-react';

import { AgentBadge, type BadgeState } from '@/components/AgentBadge';
import { emitAgentState } from '@/lib/agent-state';

export type AgentCheckResult = { state: BadgeState; ansName: string; reason?: string; score?: number };

/**
 * The employer's half of the handshake: is the agent claiming to act for a
 * candidate actually that candidate's registered agent? The first result is
 * verified on the server so the badge renders already decided; re-checks run
 * through the same /api/verify the applicant side uses, roles swapped.
 */
export function ApplicantAgentCheck({ initial }: { initial: AgentCheckResult }) {
  const [ansName, setAnsName] = useState(initial.ansName);
  const [result, setResult] = useState<AgentCheckResult>(initial);
  const inputId = useId();

  async function check() {
    const target = ansName.trim();
    if (!target) return;
    setResult({ state: 'checking', ansName: target });
    emitAgentState({ state: 'thinking' });
    try {
      const response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ans_name: target, expected_role: 'applicant', purpose: 'recruiting_invitation' }),
      });
      const payload = (await response.json()) as {
        verdict: 'pass' | 'refuse';
        spoken_reason: string;
        dimensions?: { score: number }[];
      };
      const score = payload.dimensions?.length
        ? Math.round(payload.dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / payload.dimensions.length)
        : undefined;
      setResult({
        state: payload.verdict === 'pass' ? 'verified' : 'refused',
        ansName: target,
        reason: payload.spoken_reason,
        score,
      });
      emitAgentState({ state: payload.verdict === 'pass' ? 'speaking' : 'refusing', spoken_reason: payload.spoken_reason });
    } catch {
      setResult({
        state: 'refused',
        ansName: target,
        reason: 'The agent registry could not be reached, so this candidate is not verified.',
      });
      emitAgentState({ state: 'refusing' });
    }
  }

  return (
    <div className="trust-body">
      <AgentBadge party="applicant" state={result.state} ansName={result.ansName} reason={result.reason} score={result.score} />
      <div className="field">
        <label htmlFor={inputId}>Check another applicant agent</label>
        <input
          id={inputId}
          value={ansName}
          onChange={(event) => setAnsName(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="ans://v1.0.0.applicant.example.com"
        />
      </div>
      <div className="trust-actions">
        <button type="button" className="secondary trust-speak" onClick={check} disabled={result.state === 'checking'}>
          {result.state === 'checking' ? (
            <>
              <Loader2 size={16} className="spin" aria-hidden="true" /> Checking…
            </>
          ) : (
            <>
              <Search size={16} aria-hidden="true" /> Check this agent
            </>
          )}
        </button>
      </div>
      <p className="sr-only" aria-live="polite">
        {result.state === 'checking' ? 'Checking the applicant agent.' : (result.reason ?? '')}
      </p>
    </div>
  );
}
