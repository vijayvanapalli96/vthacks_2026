/**
 * agent-state.ts — one browser event for "what is the agent doing right now".
 *
 * Every screen that runs an agent step announces its state here, and anything
 * that visualises the agent (the voice orb on the UI branch, the inline status
 * pill) listens. The orb's states match exactly, so wiring it is one listener:
 *
 *   window.addEventListener('hirewire:agent-state', (e) => setState(e.detail.state))
 *
 * `spoken_reason` is the exact sentence to say out loud; never paraphrase it.
 */
export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'refusing';

export type AgentStateDetail = { state: AgentState; spoken_reason?: string };

export const AGENT_STATE_EVENT = 'hirewire:agent-state';

export function emitAgentState(detail: AgentStateDetail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AgentStateDetail>(AGENT_STATE_EVENT, { detail }));
}
