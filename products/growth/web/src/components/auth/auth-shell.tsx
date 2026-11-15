import { Outlet } from "react-router";

import styles from "./auth-shell.module.css";

export function AuthShell() {
  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <main className={styles.main}>
          <div className={styles.card}>
            <img
              src="/logo.png"
              alt="KasiTek"
              width={36}
              height={36}
              className={styles.logo}
            />
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
