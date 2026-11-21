import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves the site from /dryspell/
export default defineConfig({
  base: "/dryspell/",
  plugins: [react()],
});
