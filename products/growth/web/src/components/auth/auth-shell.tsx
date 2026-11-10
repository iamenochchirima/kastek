import { ArrowUpRight } from "lucide-react";
import { Link, Outlet } from "react-router";

import styles from "./auth-shell.module.css";

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
          <div className={styles.card}>
            <Outlet />
          </div>
          <p className={styles.legal}>
            By continuing you agree to the{" "}
            <a href="https://kasitek.co.za/terms">Terms</a> and{" "}
            <a href="https://kasitek.co.za/privacy-policy">Privacy Policy</a>.
          </p>
        </main>
      </div>
    </div>
  );
}
