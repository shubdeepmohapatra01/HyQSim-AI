import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Set base path for deployment to a subdirectory
  // Use environment variable or default to '/'
  // For NC State: VITE_BASE_PATH=/cvdv-ncsu-edu/
  base: process.env.VITE_BASE_PATH || '/',
})
