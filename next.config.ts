import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Local setup links use this loopback hostname as well as localhost.
  allowedDevOrigins: ['127.0.0.1'],
  // Setup/recovery callback URLs carry credentials; omit them from dev request logs.
  logging: { incomingRequests: { ignore: [/\/auth\/confirm(?:\?|$)/] } },
  reactStrictMode: true,
  experimental: {
    serverActions: {
      // A Server Action's request body is capped at 1 MB by default, which the
      // admin import would hit on the master inventory: 7,500 machines is a
      // couple of megabytes of CSV, sent as an argument to a Server Action.
      // The import refuses a file over 5 MB itself, with a sentence saying so;
      // this is the ceiling that lets that refusal be the one the operator sees.
      bodySizeLimit: '5mb',
    },
  },
};

export default nextConfig;
