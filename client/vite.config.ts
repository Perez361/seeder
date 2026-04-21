// vite.config.ts
export default {
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/files': 'http://localhost:3001'
    }
  }
}