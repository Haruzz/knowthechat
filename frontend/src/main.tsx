import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import Site from "./Site";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root application mount point.");

createRoot(root).render(
  <StrictMode>
    <Site />
  </StrictMode>,
);
