/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dev badge sits bottom-left, on top of the Settings button.
  // Next 15.1 wants an object here; a bare `false` is rejected and the badge returns.
  devIndicators: {
    buildActivity: false,
    appIsrStatus: false,
  },
  // The chat route shells out to the `claude` CLI, which can run for minutes.
  experimental: {
    proxyTimeout: 1000 * 60 * 20,
  },
};

export default nextConfig;
