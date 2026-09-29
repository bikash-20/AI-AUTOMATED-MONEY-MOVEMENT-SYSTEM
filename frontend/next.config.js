/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: "http://127.0.0.1:8000/:path*" },
    ];
  },
  webpack: (config, { isServer }) => {
    // Server-side: alias out voice packages entirely. They only run
    // in the browser, so SSR/Edge don't need them.
    if (isServer) {
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        "onnxruntime-web": false,
        "openwakeword-web": false,
        "openwakeword-web/microphone": false,
        "@ricky0123/vad-web": false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;