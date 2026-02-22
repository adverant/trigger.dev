/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath: '/trigger/ui',
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || '',
    NEXT_PUBLIC_WS_PATH: process.env.NEXT_PUBLIC_WS_PATH || '/trigger/ws',
  },
};

module.exports = nextConfig;
