/** Pure decision for resuming a truncated owned browsing turn; never resumes a host goal itself. */
export const MAX_CONSECUTIVE_TRUNCATIONS = 2
const finite = value => typeof value === 'number' && Number.isFinite(value)
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0

/**
 * `madeProgress` means an observed successful browsing tool result, never model narration.
 * The caller captures a real turn identity and rechecks current ownership/intervention before resume().
 * Budget values are cumulative for this run; unknown usage cannot authorize extra budgeted work.
 */
export function sessionContinuationDecision({ goal, run, selected, endReason, turnId,
  madeProgress = false, intervened = false, state, now = Date.now() } = {}) {
  const previous = {
    lastTurn: typeof state?.lastTurn === 'string' ? state.lastTurn : '',
    consecutiveTruncations: count(state?.consecutiveTruncations),
  }
  const turn = typeof turnId === 'string' && turnId ? turnId
    : Number.isSafeInteger(turnId) && turnId >= 0 ? String(turnId) : ''
  const result = (reason, next = previous, recover = false) => ({ recover, reason, state: next })
  if (!turn) return result('turn-unknown')
  if (previous.lastTurn === turn) return result('already-handled')
  const consecutive = endReason === 'completed' && madeProgress === true ? 0 : previous.consecutiveTruncations
  const next = { lastTurn: turn, consecutiveTruncations: consecutive + (endReason === 'max-tokens' ? 1 : 0) }
  if (endReason !== 'max-tokens') return result(endReason === 'completed' ? 'completed' : 'turn-not-truncated', next)
  if (selected !== true) return result('mode-exit', next)
  if (!goal || !run || typeof run.goalId !== 'string' || !run.goalId || goal.id !== run.goalId) return result('goal-not-owned', next)
  if (run.stoppedAt || intervened === true) return result('interrupted', next)
  if (madeProgress !== true) return result('no-progress', next)
  if (goal.phase !== 'active' || goal.activation !== 'disarmed') return result('goal-not-disarmed', next)
  if (!Number.isSafeInteger(goal.roundsStarted) || !Number.isSafeInteger(goal.maxGoalRounds)
    || goal.roundsStarted < 0 || goal.maxGoalRounds < 1 || goal.roundsStarted >= goal.maxGoalRounds) return result('round-limit', next)
  if (!finite(now) || (run.deadlineAt && (!finite(run.deadlineAt) || now >= run.deadlineAt))) return result('time-limit', next)
  for (const [budgetKey, usageKey, reason] of [
    ['tokenBudget', 'tokensUsed', 'token-budget'],
    ['totalTokenBudget', 'totalTokensUsed', 'total-budget'],
  ]) {
    const budget = run[budgetKey]
    if (budget !== undefined && (!finite(budget) || budget < 0)) return result('budget-invalid', next)
    if (budget > 0) {
      const used = run[usageKey]
      if (!finite(used) || used < 0) return result('usage-unknown', next)
      if (used >= budget) return result(reason, next)
    }
  }
  if (next.consecutiveTruncations > MAX_CONSECUTIVE_TRUNCATIONS) return result('truncation-limit', next)
  return result('max-tokens', next, true)
}
