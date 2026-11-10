import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import SandboxesPage from "./pages/SandboxesPage";
import SandboxDetailPage from "./pages/SandboxDetailPage";
import SandboxAgentChatPage from "./pages/SandboxAgentChatPage";
import SessionsPage from "./pages/SessionsPage";
import SessionDetailPage from "./pages/SessionDetailPage";
import OutcomesPage from "./pages/OutcomesPage";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<SandboxesPage />} />
          <Route path="sandboxes/:id" element={<SandboxDetailPage />} />
          <Route path="sandboxes/:id/chat/:agentRefId" element={<SandboxAgentChatPage />} />
          <Route path="sandboxes/:id/sessions/:sessionId" element={<SessionDetailPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="outcomes" element={<OutcomesPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
