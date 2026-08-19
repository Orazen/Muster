import { useState, useCallback } from "react";
import {
  Bot,
  Room,
  Message,
  Approval,
  ConnectionState,
} from "./types";
import { client } from "./client";

export interface AppState {
  connection: ConnectionState;
  bots: Bot[];
  rooms: Room[];
  messages: Record<string, Message[]>;
  approvals: Approval[];
  selectedRoomId: string | null;
}

const initialState: AppState = {
  connection: { status: "disconnected" },
  bots: [],
  rooms: [],
  messages: {},
  approvals: [],
  selectedRoomId: null,
};

export function useMusterStore() {
  const [state, setState] = useState<AppState>(initialState);

  const setConnection = useCallback(
    (connection: Partial<ConnectionState>) => {
      setState((s) => ({
        ...s,
        connection: { ...s.connection, ...connection },
      }));
    },
    []
  );

  const loadRooms = useCallback(async () => {
    try {
      const rooms = await client.getRooms();
      setState((s) => ({ ...s, rooms }));
    } catch (e) {
      console.error("Failed to load rooms:", e);
    }
  }, []);

  const loadBots = useCallback(async () => {
    try {
      const bots = await client.getBots();
      setState((s) => ({ ...s, bots }));
    } catch (e) {
      console.error("Failed to load bots:", e);
    }
  }, []);

  const loadMessages = useCallback(async (roomId: string) => {
    try {
      const messages = await client.getMessages(roomId);
      setState((s) => ({
        ...s,
        messages: { ...s.messages, [roomId]: messages },
      }));
    } catch (e) {
      console.error("Failed to load messages:", e);
    }
  }, []);

  const sendMessage = useCallback(
    async (roomId: string, content: string) => {
      try {
        const msg = await client.sendMessage(roomId, content);
        setState((s) => ({
          ...s,
          messages: {
            ...s.messages,
            [roomId]: [...(s.messages[roomId] || []), msg],
          },
        }));
      } catch (e) {
        console.error("Failed to send message:", e);
      }
    },
    []
  );

  const loadApprovals = useCallback(async () => {
    try {
      const approvals = await client.getApprovals();
      setState((s) => ({ ...s, approvals }));
    } catch (e) {
      console.error("Failed to load approvals:", e);
    }
  }, []);

  const approve = useCallback(async (id: string) => {
    try {
      await client.approve(id);
      setState((s) => ({
        ...s,
        approvals: s.approvals.map((a) =>
          a.id === id ? { ...a, status: "approved" as const } : a
        ),
      }));
    } catch (e) {
      console.error("Failed to approve:", e);
    }
  }, []);

  const deny = useCallback(async (id: string) => {
    try {
      await client.deny(id);
      setState((s) => ({
        ...s,
        approvals: s.approvals.map((a) =>
          a.id === id ? { ...a, status: "denied" as const } : a
        ),
      }));
    } catch (e) {
      console.error("Failed to deny:", e);
    }
  }, []);

  const answerQuestion = useCallback(
    async (id: string, answer: string) => {
      try {
        await client.answerQuestion(id, answer);
        setState((s) => ({
          ...s,
          approvals: s.approvals.map((a) =>
            a.id === id ? { ...a, status: "approved" as const } : a
          ),
        }));
      } catch (e) {
        console.error("Failed to answer question:", e);
      }
    },
    []
  );

  const selectRoom = useCallback((roomId: string | null) => {
    setState((s) => ({ ...s, selectedRoomId: roomId }));
  }, []);

  const handleEvent = useCallback(
    (event: { type: string; data: any }) => {
      switch (event.type) {
        case "message":
          setState((s) => {
            const roomId = event.data.roomId;
            const existing = s.messages[roomId] || [];
            if (existing.find((m) => m.id === event.data.id)) return s;
            return {
              ...s,
              messages: {
                ...s.messages,
                [roomId]: [...existing, event.data],
              },
            };
          });
          break;
        case "message.patch":
          setState((s) => {
            const roomId = event.data.roomId;
            const existing = s.messages[roomId] || [];
            return {
              ...s,
              messages: {
                ...s.messages,
                [roomId]: existing.map((m) =>
                  m.id === event.data.id
                    ? { ...m, content: event.data.content }
                    : m
                ),
              },
            };
          });
          break;
        case "approval":
          setState((s) => ({
            ...s,
            approvals: [...s.approvals, event.data],
          }));
          break;
        case "bot":
          setState((s) => ({
            ...s,
            bots: s.bots.map((b) =>
              b.id === event.data.id ? { ...b, ...event.data } : b
            ),
          }));
          break;
      }
    },
    []
  );

  return {
    state,
    setConnection,
    loadRooms,
    loadBots,
    loadMessages,
    sendMessage,
    loadApprovals,
    approve,
    deny,
    answerQuestion,
    selectRoom,
    handleEvent,
  };
}
