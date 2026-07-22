import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{tsx,jsx,mdx}",
    "./components/**/*.{tsx,jsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "var(--theme-bg)",
          soft: "var(--theme-bg-soft)",
          card: "var(--theme-bg-card)",
          border: "var(--theme-bg-border)",
          elevated: "var(--theme-bg-elevated)",
          overlay: "var(--theme-bg-overlay)",
        },
        content: {
          DEFAULT: "var(--theme-content)",
          soft: "var(--theme-content-soft)",
          muted: "var(--theme-content-muted)",
          faint: "var(--theme-content-faint)",
          inverted: "var(--theme-content-inverted)",
        },
        primary: {
          DEFAULT: "var(--theme-primary)",
          foreground: "var(--theme-primary-foreground)",
          soft: "var(--theme-primary-soft)",
          border: "var(--theme-primary-border)",
        },
        ring: {
          DEFAULT: "var(--theme-ring)",
        },
        success: {
          DEFAULT: "var(--theme-success)",
          foreground: "var(--theme-success-foreground)",
          soft: "var(--theme-success-soft)",
          border: "var(--theme-success-border)",
        },
        warning: {
          DEFAULT: "var(--theme-warning)",
          foreground: "var(--theme-warning-foreground)",
          soft: "var(--theme-warning-soft)",
          border: "var(--theme-warning-border)",
        },
        danger: {
          DEFAULT: "var(--theme-danger)",
          foreground: "var(--theme-danger-foreground)",
          soft: "var(--theme-danger-soft)",
          border: "var(--theme-danger-border)",
        },
        neon: {
          green: "var(--theme-primary)",
          purple: "var(--theme-secondary)",
          blue: "var(--theme-info)",
          red: "var(--theme-danger)",
        },
      },
      fontFamily: {
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        "neon-green": "0 0 12px var(--theme-primary-glow), 0 0 32px color-mix(in srgb, var(--theme-primary) 20%, transparent)",
        "neon-purple": "0 0 12px color-mix(in srgb, var(--theme-secondary) 45%, transparent)",
        "glass": "inset 0 1px 0 rgba(255,255,255,0.04)",
        "surface": "0 18px 48px -28px rgba(0,0,0,0.72)",
        "surface-soft": "0 12px 30px -22px rgba(0,0,0,0.62)",
      },
      backdropBlur: {
        xs: "2px",
      },
      animation: {
        "pulse-soft": "pulse 3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
