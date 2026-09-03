import App from "./App";
import PrivacyPage from "./PrivacyPage";

export function isPrivacyPath(pathname: string) {
  return pathname === "/privacy" || pathname === "/privacy/";
}

export default function Site() {
  return isPrivacyPath(window.location.pathname) ? <PrivacyPage /> : <App />;
}
