/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dev badge sits bottom-left, on top of the Settings button.
  devIndicators: false,
  // The chat route shells out to the `claude` CLI, which can run for minutes.
  experimental: {
    proxyTimeout: 1000 * 60 * 20,
  },
};

export default nextConfig;
