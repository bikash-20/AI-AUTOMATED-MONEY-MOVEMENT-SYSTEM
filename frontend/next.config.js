/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // Proxy /api/* to the FastAPI backend in dev so the browser doesn't have
    // to deal with CORS or different ports.
    return [
      { source: "/api/:path*", destination: "http://127.0.0.1:8000/:path*" },
    ];
  },
};

module.exports = nextConfig;
