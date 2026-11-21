import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { Boxes, ClipboardCheck, MessageSquare, Settings2 } from "lucide-react";
import type { ServiceHealth } from "../../shared/types";
import { api } from "./api";

const navigation = [
  { to: "/", label: "Sandboxes", icon: Boxes, end: true },
  { to: "/sessions", label: "Sessions", icon: MessageSquare },
  { to: "/outcomes", label: "Outcomes", icon: ClipboardCheck },
  { to: "/configuration", label: "Configuration", icon: Settings2 },
];

export default function App() {
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    api<ServiceHealth>("/api/health").then(setHealth).catch(() => setUnreachable(true));
  }, []);

  const ready = health?.ok === true;
  const label = unreachable
    ? "Client server offline"
    : health?.controlPlane.status === "operator-token-missing"
      ? "Operator token missing"
      : ready ? "Control plane" : "Checking control plane";

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">E</div>
          <div>
            <div className="brand-name">Evals</div>
            <div className="brand-sub">Evaluation service</div>
          </div>
        </div>
        <nav className="nav">
          {navigation.map(({ to, label: navLabel, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
              <Icon size={17} strokeWidth={1.8} />
              <span>{navLabel}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`dot${ready ? "" : " offline"}`} />
          {label}
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
