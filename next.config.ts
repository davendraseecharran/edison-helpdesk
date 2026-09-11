import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Local setup links use this loopback hostname as well as localhost.
  allowedDevOrigins: ['127.0.0.1'],
  // Setup/recovery callback URLs carry credentials; omit them from dev request logs.
  logging: { incomingRequests: { ignore: [/\/auth\/confirm(?:\?|$)/] } },
  reactStrictMode: true,
};

export default nextConfig;
