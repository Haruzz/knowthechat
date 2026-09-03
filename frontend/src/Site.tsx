import App from "./App";
import AdRailLayout from "./AdRailLayout";
import PrivacyPage from "./PrivacyPage";

export function isPrivacyPath(pathname: string) {
  return pathname === "/privacy" || pathname === "/privacy/";
}

export default function Site() {
  return isPrivacyPath(window.location.pathname) ? (
    <PrivacyPage />
  ) : (
    <AdRailLayout>
      <App />
    </AdRailLayout>
  );
}
