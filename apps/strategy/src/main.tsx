import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// The shared design tokens (colours, type scale, spacing, radii) — index.html links the
// same file. See design-tokens.css's own header for why this is tokens only, no shared
// components.
import "../../../design-tokens.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
