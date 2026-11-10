import { ArrowUpRight } from "lucide-react";
import Link from "@/lib/link";

import styles from "./auth-shell.module.css";

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <Link href="/" className={styles.brand} aria-label="KasiTek Agency home">
            kasitek<span>/ agency</span>
          </Link>
          <Link href="/" className={styles.home}>
            Back to home <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </header>
        <main className={styles.main}>
          <div className={styles.card}>{children}</div>
        </main>
      </div>
    </div>
  );
}
