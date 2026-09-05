import App from "./App";
import AudioCreditsPage from "./AudioCreditsPage";
import PrivacyPage from "./PrivacyPage";

export function isPrivacyPath(pathname: string) {
  return pathname === "/privacy" || pathname === "/privacy/";
}

export default function Site() {
  if (["/audio-credits", "/audio-credits/"].includes(window.location.pathname))
    return <AudioCreditsPage />;
  return isPrivacyPath(window.location.pathname) ? <PrivacyPage /> : <App />;
}
