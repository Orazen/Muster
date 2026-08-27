/**
 * Push Notifications API
 */
import admin from 'firebase-admin';

const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount as any) });
}

export const notificationService = {
  async sendToDevice(token: string, title: string, body: string, data?: any) {
    return admin.messaging().send({
      token,
      notification: { title, body },
      data: data || {},
    });
  },

  async sendToMultiple(tokens: string[], title: string, body: string) {
    return admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
    });
  },

  async sendToTopic(topic: string, title: string, body: string) {
    return admin.messaging().send({
      topic,
      notification: { title, body },
    });
  },
};

export default notificationService;
