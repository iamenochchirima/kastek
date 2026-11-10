import { ArrowUpRight, Check } from "lucide-react";
import Link from "@/lib/link";

import styles from "./auth-shell.module.css";

const points = [
  "Your brand on every client portal",
  "Separate workspaces for each business",
  "One partner account for your team",
];

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <aside className={styles.story}>
        <Link href="/" className={styles.brand} aria-label="KasiTek Agency home">
          kasitek<span>/ agency</span>
        </Link>

        <div className={styles.storyCopy}>
          <p className={styles.kicker}>KasiTek Agency</p>
          <p className={styles.storyHeadline}>
            Own the
            <br />
            <em>relationship.</em>
          </p>
          <p>
            White-label workspaces for your agency, your clients and the team
            behind them.
          </p>
          <ul className={styles.points}>
            {points.map((point) => (
              <li key={point}>
                <Check size={16} aria-hidden="true" />
                {point}
              </li>
            ))}
          </ul>
        </div>

        <p className={styles.storyFoot}>
          <span aria-hidden="true" />
          Built for agencies that deliver.
        </p>
      </aside>

      <main className={styles.side}>
        <div className={styles.top}>
          <Link href="/" className={styles.home}>
            Back to home <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </div>
        <div className={styles.sideMain}>
          <div className={styles.card}>{children}</div>
        </div>
      </main>
    </div>
  );
}
