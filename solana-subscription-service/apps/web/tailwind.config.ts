import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#121417",
        panel: "#f7f8f3",
        line: "#d9dfd0",
        mint: "#2fbf8f",
        ocean: "#256d85",
        saffron: "#f6b73c",
        coral: "#e7685d"
      }
    }
  },
  plugins: []
};

export default config;
