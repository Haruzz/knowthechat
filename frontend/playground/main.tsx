import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import StreakPreview from "./StreakPreview";
import "../src/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root playground mount point.");

createRoot(root).render(
  <StrictMode>
    <StreakPreview />
  </StrictMode>,
);
