/**
 * Mobile App Scaffolding for Muster+
 * PWA + React Native ready
 */

export interface MobileConfig {
  appName: string;
  bundleId: string;
  iconPath: string;
  deepLinking: boolean;
  pushNotifications: boolean;
  biometricAuth: boolean;
}

export interface PushNotification {
  id: string;
  title: string;
  body: string;
  data?: any;
  timestamp: number;
}

export class MobileApp {
  private config: MobileConfig;
  private notifications: PushNotification[] = [];
  private isInstalled: boolean = false;

  constructor(config: Partial<MobileConfig> = {}) {
    this.config = {
      appName: config.appName || 'Muster+',
      bundleId: config.bundleId || 'com.musterplus.app',
      iconPath: config.iconPath || '/assets/icons/icon-192.png',
      deepLinking: config.deepLinking ?? true,
      pushNotifications: config.pushNotifications ?? true,
      biometricAuth: config.biometricAuth ?? true,
    };
  }

  async installPWA(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    if (window.matchMedia('(display-mode: standalone)').matches) {
      this.isInstalled = true;
      return true;
    }
    return new Promise((resolve) => {
      window.addEventListener('beforeinstallprompt', (e: any) => {
        e.preventDefault();
        e.prompt();
        e.userChoice.then((choice: any) => {
          this.isInstalled = choice.outcome === 'accepted';
          resolve(this.isInstalled);
        });
      });
    });
  }

  async registerServiceWorker(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch (error) {
      console.error('SW registration failed:', error);
    }
  }

  async requestNotificationPermission(): Promise<boolean> {
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const permission = await Notification.requestPermission();
    return permission === 'granted';
  }

  async sendNotification(notification: Omit<PushNotification, 'timestamp'>): Promise<void> {
    if (typeof Notification === 'undefined') return;
    const full: PushNotification = { ...notification, timestamp: Date.now() };
    this.notifications.push(full);
    if (Notification.permission === 'granted') {
      new Notification(full.title, { body: full.body, data: full.data });
    }
  }

  async authenticateWithBiometrics(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    if (!(window as any).PublicKeyCredential) return false;
    try {
      return await (window as any).PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }

  handleDeepLink(url: string): void {
    if (!this.config.deepLinking) return;
    const urlObj = new URL(url);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('muster-deep-link', {
        detail: { path: urlObj.pathname, params: Object.fromEntries(urlObj.searchParams) },
      }));
    }
  }

  getAppInfo(): any {
    return { ...this.config, installed: this.isInstalled, notifications: this.notifications.length };
  }

  generateManifest(): any {
    return {
      name: this.config.appName,
      short_name: 'Muster+',
      start_url: '/',
      display: 'standalone',
      background_color: '#030711',
      theme_color: '#00bbff',
      icons: [
        { src: '/assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/assets/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    };
  }
}

export const mobileApp = new MobileApp();
