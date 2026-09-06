import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// Before the first paint, so a non-default skin never flashes Midnight.
import { restoreTheme } from "./lib/skins";
import "./styles.css";
import "./styles/fleet-orb.css";

restoreTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
