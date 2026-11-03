import { Navigate } from "react-router-dom";

/** New accounts begin in the campaign workspace. Agent setup remains available from /app/agents. */
export function OnboardingPage() {
  return <Navigate to="/app" replace />;
}
