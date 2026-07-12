import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Plain SPA. The /api/* routes are Vercel serverless functions and are not
// part of the Vite build; in local dev they are served by `vercel dev`.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
})
