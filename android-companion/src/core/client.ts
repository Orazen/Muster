import * as SecureStore from "expo-secure-store";
import { Bot, Room, Message, Approval, PairingInfo } from "./types";

const TOKEN_KEY = "muster-pairing-token";
const ADDRESS_KEY = "muster-address";

export class MusterClient {
  private address: string = "";
  private token: string = "";

  async loadCredentials(): Promise<boolean> {
    const address = await SecureStore.getItemAsync(ADDRESS_KEY);
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    if (address && token) {
      this.address = address;
      this.token = token;
      return true;
    }
    return false;
  }

  async saveCredentials(address: string, token: string): Promise<void> {
    this.address = address;
    this.token = token;
    await SecureStore.setItemAsync(ADDRESS_KEY, address);
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  }

  async clearCredentials(): Promise<void> {
    this.address = "";
    this.token = "";
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(ADDRESS_KEY);
  }

  private get baseUrl(): string {
    return `http://${this.address}`;
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, {
        headers: this.headers,
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async pair(info: PairingInfo): Promise<string> {
    const res = await fetch(`${info.address}/api/companion/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: info.code }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Pairing failed" }));
      throw new Error(error.error || "Pairing failed");
    }
    const data = await res.json();
    return data.token;
  }

  async getBots(): Promise<Bot[]> {
    const res = await fetch(`${this.baseUrl}/api/bots`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error("Failed to fetch bots");
    return res.json();
  }

  async getRooms(): Promise<Room[]> {
    const res = await fetch(`${this.baseUrl}/api/rooms`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error("Failed to fetch rooms");
    return res.json();
  }

  async getMessages(roomId: string, limit = 50): Promise<Message[]> {
    const res = await fetch(
      `${this.baseUrl}/api/rooms/${roomId}/messages?limit=${limit}`,
      { headers: this.headers }
    );
    if (!res.ok) throw new Error("Failed to fetch messages");
    return res.json();
  }

  async sendMessage(roomId: string, content: string): Promise<Message> {
    const res = await fetch(`${this.baseUrl}/api/rooms/${roomId}/messages`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error("Failed to send message");
    return res.json();
  }

  async getApprovals(): Promise<Approval[]> {
    const res = await fetch(`${this.baseUrl}/api/approvals`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error("Failed to fetch approvals");
    return res.json();
  }

  async approve(approvalId: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/approvals/${approvalId}/approve`,
      {
        method: "POST",
        headers: this.headers,
      }
    );
    if (!res.ok) throw new Error("Failed to approve");
  }

  async deny(approvalId: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/approvals/${approvalId}/deny`,
      {
        method: "POST",
        headers: this.headers,
      }
    );
    if (!res.ok) throw new Error("Failed to deny");
  }

  async answerQuestion(approvalId: string, answer: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/approvals/${approvalId}/answer`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ answer }),
      }
    );
    if (!res.ok) throw new Error("Failed to answer question");
  }

  getEventStreamUrl(): string {
    return `${this.baseUrl}/api/events/stream`;
  }
}

export const client = new MusterClient();
