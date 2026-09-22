import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Plum / mauve palette per PRD
        plum: {
          950: "#2d2330",
          900: "#3a2e3d",
          850: "#433542",
          800: "#4a3b4d",
          700: "#5a485d",
          600: "#6b5570",
          500: "#7c647f",
          400: "#8a738d",
        },
        mauve: {
          card: "#6b5a6e",
          accent: "#a08ba3",
        },
        peach: {
          500: "#f0a585",
          400: "#f4b89d",
          300: "#f7cdb6",
        },
        cream: "#f2e9e4",
        lavender: "#b8a8b8",
      },
      fontFamily: {
        sans: ["Inter", "SF Pro Display", "system-ui", "sans-serif"],
      },
      backgroundImage: {
        "plum-gradient":
          "radial-gradient(at 0% 0%, #6b5570 0%, transparent 50%), radial-gradient(at 100% 100%, #4a3b4d 0%, transparent 50%), linear-gradient(135deg, #4a3b4d 0%, #6b5570 100%)",
      },
      backdropBlur: {
        xs: "2px",
      },
      boxShadow: {
        "glass":
          "0 8px 32px 0 rgba(31, 24, 38, 0.37), inset 0 1px 0 0 rgba(255, 255, 255, 0.05)",
        "glow-peach":
          "0 0 24px 0 rgba(240, 165, 133, 0.35), 0 0 8px 0 rgba(240, 165, 133, 0.2)",
      },
    },
  },
  plugins: [],
};

export default config;
