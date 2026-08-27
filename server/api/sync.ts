/**
 * Cloud Sync API
 */
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

interface SyncPayload {
  deviceId: string;
  userId: string;
  encryptedData: string;
  timestamp: number;
}

class SyncServer {
  private wss: WebSocketServer | null = null;

  initialize(port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws) => {
      ws.on('message', (data) => this.handleMessage(data.toString()));
    });
  }

  private handleMessage(data: string) {
    try {
      const payload: SyncPayload = JSON.parse(data);
      this.broadcast(payload);
    } catch (e) { console.error(e); }
  }

  private broadcast(payload: SyncPayload) {
    if (!this.wss) return;
    this.wss.clients.forEach((client: any) => {
      if (client.readyState === 1) {
        client.send(JSON.stringify(payload));
      }
    });
  }

  generatePairingCode(): string {
    return crypto.randomBytes(16).toString('hex');
  }
}

export const syncServer = new SyncServer();
export default syncServer;
