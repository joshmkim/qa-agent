/**
 * Shared contracts for the Agentic QA Fleet.
 *
 * The two contracts that are the system's real API:
 *   - ContextBundle: orchestrator -> agent
 *   - Finding:       agent -> orchestrator
 *
 * Everything else here is control-plane data shape consumed by the web UI.
 */

export * from "./agent-result";
export * from "./context-bundle";
export * from "./finding";
export * from "./pipeline";
