/**
 * Shared domain rules.
 *
 * Logic that is neither transport nor persistence, and that BOTH the API and
 * the worker must agree on. The health state machine is the clearest example:
 * the worker applies transitions when a probe completes, and the API reports
 * the resulting state, so a divergent copy in each app would be a real bug.
 *
 * Keeping it here is what lets the modular monolith split into services later
 * without the two halves drifting apart (report 9.1).
 */
export * from './health-scoring.js';
