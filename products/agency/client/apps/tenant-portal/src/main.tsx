import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import "@fontsource/geist-mono/latin-400.css";
import "./styles/app.css";
import { bootstrapAppearance } from "@/components/theme-script";
import { initializeAppearance } from "@/lib/appearance";
import Providers from "@/components/providers";
import { AgencyRoutes } from "@/routes";
bootstrapAppearance();
initializeAppearance();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Providers>
        <AgencyRoutes />
      </Providers>
    </BrowserRouter>
  </React.StrictMode>,
);
