// The helper's lifecycle as a pure state machine: step(state, event, now) -> state.
//
//   idle --check--> checking --build--> building --start--> starting --ready--> ready
//                       \------------------start-----------------/
//   any --fail--> error (retried after a backoff) or fallback (screenshots until Refresh)
//   ready --lost--> idle (start again at once), counted as a failure
//   any --stop--> idle;  any --reset--> idle with the failures forgotten (Refresh)

export const MAX_FAILURES = 3;
export const RETRY_MS = 5000;
export const HEALTHY_MS = 30_000;  // a helper up this long forgets earlier failures

export const initial = () => ({ phase: "idle", reason: null, failures: 0, retryAt: 0, readyAt: 0 });

export function step(s, ev, now = Date.now()) {
  const type = ev?.type;
  switch (type) {
    case "reset": return initial();
    case "stop": return s.phase === "fallback" ? s : { ...s, phase: "idle" };
    case "unsupported": return { ...s, phase: "fallback", reason: ev.reason ?? "Not supported here" };
    case "check":
      if (s.phase === "idle" || (s.phase === "error" && now >= s.retryAt)) return { ...s, phase: "checking", reason: null };
      return s;
    case "build": return s.phase === "checking" ? { ...s, phase: "building" } : s;
    case "start": return s.phase === "checking" || s.phase === "building" ? { ...s, phase: "starting" } : s;
    case "ready": return s.phase === "starting" ? { ...s, phase: "ready", reason: null, readyAt: now } : s;
    case "healthy": return s.phase === "ready" && now - s.readyAt >= HEALTHY_MS ? { ...s, failures: 0 } : s;
    case "lost": {
      if (s.phase !== "ready") return s;
      const failures = s.failures + 1;
      if (failures >= MAX_FAILURES) return { ...s, phase: "fallback", reason: ev.reason ?? "The helper keeps stopping", failures };
      return { ...s, phase: "idle", failures };
    }
    case "fail": {
      if (s.phase === "fallback" || s.phase === "idle") return s;
      const failures = s.failures + 1;
      const reason = ev.reason ?? "The helper failed";
      if (ev.permanent || failures >= MAX_FAILURES) return { ...s, phase: "fallback", reason, failures };
      return { ...s, phase: "error", reason, failures, retryAt: now + RETRY_MS * failures };
    }
    default: return s;
  }
}

/** Whether the live view (helper frames + input) is in use. */
export const isLive = (s) => s?.phase === "ready";

/** The one line the panel shows for the helper, or null when there is nothing to say. */
export function statusText(s) {
  switch (s?.phase) {
    case "checking": return "Checking helper…";
    case "building": return "Building helper…";
    case "starting": return "Starting helper…";
    case "error": return `Screenshots for now: ${s.reason}`;
    case "fallback": return `Screenshots only: ${s.reason}`;
    default: return null;
  }
}
