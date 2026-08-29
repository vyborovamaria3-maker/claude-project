"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import styles from "./preview.module.css";

function FrameCard({
  title,
  subtitle,
  src,
  mobile,
}: {
  title: string;
  subtitle: string;
  src: string;
  mobile?: boolean;
}) {
  return (
    <section className={`${styles.card} ${mobile ? styles.mobileCard : ""}`}>
      <div className={styles.cardHead}>
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <span className={styles.badge}>{mobile ? "Mobile" : "Desktop"}</span>
      </div>
      <div className={`${styles.frameWrap} ${mobile ? styles.frameMobile : ""}`}>
        <iframe title={title} src={src} className={styles.frame} />
      </div>
    </section>
  );
}

export default function PreviewPage() {
  const [baseUrl, setBaseUrl] = useState("");

  useEffect(() => {
    setBaseUrl(window.location.origin);
  }, []);

  const landingSrc = useMemo(() => (baseUrl ? `${baseUrl}/` : "/"), [baseUrl]);
  const miniappSrc = useMemo(() => (baseUrl ? `${baseUrl}/miniapp` : "/miniapp"), [baseUrl]);

  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div>
          <div className={styles.kicker}>Local preview</div>
          <h1>Новый лендинг и новый Mini App в одном окне</h1>
          <p>
            Открой эту страницу локально, чтобы сразу проверить новый landing login flow,
            Telegram Mini App визуал, и реальный backend/auth/payment flow.
          </p>
        </div>
        <div className={styles.actions}>
          <Link href="/" className={styles.primary}>Open Landing</Link>
          <Link href="/miniapp" className={styles.secondary}>Open Mini App</Link>
        </div>
      </header>

      <section className={styles.grid}>
        <FrameCard
          title="Site landing"
          subtitle="Главный вход на сайт с новым лендингом и формой логина"
          src={landingSrc}
        />
        <FrameCard
          title="Telegram Mini App"
          subtitle="Hologram Pro / Plasma Sweep визуал и live access flow"
          src={miniappSrc}
          mobile
        />
      </section>
    </main>
  );
}
