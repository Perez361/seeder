// vite.config.ts
export default {
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/files': 'http://localhost:3001',
      '/socket.io': { target: 'http://localhost:3001', ws: true }
    }
  }
}