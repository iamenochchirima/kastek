import { ArrowUpRight, Check } from "lucide-react";
import { Link, Outlet } from "react-router";

import styles from "./auth-shell.module.css";

const points = [
  "One inbox for every customer conversation",
  "Campaigns, content and bookings in one workspace",
  "Workspace agents that know your business",
];

export function AuthShell() {
  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <Link to="/" className={styles.brand} aria-label="KasiTek Growth home">
            kasitek<span>/ growth</span>
          </Link>
          <Link to="/" className={styles.home}>
            Back to home <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </header>

        <main className={styles.main}>
          <section className={styles.story}>
            <p className={styles.kicker}>KasiTek Growth</p>
            <p className={styles.headline}>
              Stay close to
              <br />
              <em>every customer.</em>
            </p>
            <p>
              Conversations, campaigns, content and bookings in one workspace.
              Pick up where your team left off.
            </p>
            <ul className={styles.points}>
              {points.map((point) => (
                <li key={point}>
                  <Check size={16} aria-hidden="true" />
                  {point}
                </li>
              ))}
            </ul>
            <p className={styles.footnote}>
              Built for teams that would rather talk to customers than manage
              another dashboard.
            </p>
          </section>

          <section className={styles.panel} aria-label="Account access">
            <div className={styles.card}>
              <Outlet />
            </div>
            <p className={styles.legal}>
              By continuing you agree to the{" "}
              <a href="https://kasitek.co.za/terms">Terms</a> and{" "}
              <a href="https://kasitek.co.za/privacy-policy">Privacy Policy</a>.
            </p>
          </section>
        </main>
      </div>
    </div>
  );
}
