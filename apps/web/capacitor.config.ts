import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.restaurantos.pos',
  appName: 'Restaurant OS',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: false, // Insecure cleartext over arbitrary WAN is disallowed; LAN / local cleartext is governed by network_security_config.xml
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
