// Rooms panel for the OS desktop — multiplayer agent rooms. A room is a
// shared real computer (Box cloud computer, Local VM, or OpenSandbox) that
// several bots and humans work in together; this panel lists the rooms,
// shows live membership, and handles joining, leaving, creating, and
// closing. Wire shapes are validated with zod here at the client boundary:
// GET /api/rooms → { rooms }, POST /api/rooms and the join/leave routes →
// { room } (the server module behind them is server/agent-rooms.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, DoorClosed, DoorOpen, Plus, UserRound, X } from "lucide-react";
import { z } from "zod";
import "./rooms.css";

const roomMemberSchema = z.object({
  kind: z.enum(["bot", "human"]),
  id: z.string(),
  name: z.string(),
  joinedAt: z.number(),
});

const roomSchema = z.object({
  id: z.string(),
  name: z.string(),
  computerKind: z.enum(["box", "localvm", "opensandbox"]),
  computerRef: z.string(),
  members: z.array(roomMemberSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});

type Room = z.infer<typeof roomSchema>;

const computerKindLabels = {
  box: "Box computer",
  localvm: "Local VM",
  opensandbox: "OpenSandbox",
} satisfies Record<Room["computerKind"], string>;

interface HumanIdentity {
  id: string;
  name: string;
}

/** This human's persistent identity: a stable local id plus a display
 * name the panel keeps in localStorage, so joins survive reloads. */
const HUMAN_ID_KEY = "muster.rooms.humanId";
const HUMAN_NAME_KEY = "muster.rooms.humanName";

function localHuman(): HumanIdentity {
  let id = localStorage.getItem(HUMAN_ID_KEY);
  if (!id) {
    id = `human-${crypto.randomUUID()}`;
    localStorage.setItem(HUMAN_ID_KEY, id);
  }
  const name = localStorage.getItem(HUMAN_NAME_KEY) ?? "You";
  return { id, name };
}

/** JSON fetch that never hands back untyped data: the body crosses the
 * zod schema, and non-OK responses surface the server's error string.
 * Mutating routes answer { room } — the created or updated room. */
async function fetchRoom(route: string, init: RequestInit): Promise<Room> {
  const res = await fetch(route, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = z.object({ error: z.string().optional() }).safeParse(body);
    throw new Error(message.success && message.data.error ? message.data.error : `${res.status} ${res.statusText}`);
  }
  return z.object({ room: roomSchema }).parse(body).room;
}

interface MemberChipProps {
  member: Room["members"][number];
}

function MemberChip({ member }: MemberChipProps) {
  const Icon = member.kind === "bot" ? Bot : UserRound;
  return (
    <span className={`rooms-chip rooms-chip-${member.kind}`} title={member.kind === "bot" ? "Bot" : "Human"}>
      <Icon size={12} />
      <span className="rooms-chip-name">{member.name}</span>
    </span>
  );
}

interface RoomRowProps {
  room: Room;
  selfId: string;
  busy: boolean;
  onJoin: (room: Room) => void;
  onLeave: (room: Room) => void;
  onClose: (room: Room) => void;
}

function RoomRow({ room, selfId, busy, onJoin, onLeave, onClose }: RoomRowProps) {
  const joined = room.members.some((m) => m.kind === "human" && m.id === selfId);
  return (
    <li className="rooms-row">
      <div className="rooms-row-head">
        <div className="min-w-0">
          <div className="rooms-row-name">{room.name}</div>
          <div className="rooms-row-computer">{computerKindLabels[room.computerKind]}</div>
        </div>
        <div className="rooms-row-actions">
          {joined ? (
            <button
              type="button"
              className="rooms-button"
              disabled={busy}
              onClick={() => onLeave(room)}
            >
              <DoorOpen size={13} /> Leave
            </button>
          ) : (
            <button
              type="button"
              className="rooms-button rooms-button-primary"
              disabled={busy}
              onClick={() => onJoin(room)}
            >
              <DoorClosed size={13} /> Join
            </button>
          )}
          <button
            type="button"
            className="rooms-close"
            aria-label={`Close ${room.name}`}
            disabled={busy}
            onClick={() => onClose(room)}
          >
            <X size={12} />
          </button>
        </div>
      </div>
      {room.members.length > 0 && (
        <div className="rooms-members">
          {room.members.map((member) => (
            <MemberChip key={member.id} member={member} />
          ))}
        </div>
      )}
    </li>
  );
}

export function RoomsPanel() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<Room["computerKind"]>("box");
  const [humanName, setHumanName] = useState(localHuman().name);
  const human = useRef(localHuman());
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/rooms");
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      if (alive.current) {
        setRooms(z.object({ rooms: z.array(roomSchema) }).parse(body).rooms);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "Could not load rooms");
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    // Presence changes on the server (bots joining/leaving) surface on the
    // next poll — the panel has no SSE channel of its own.
    const timer = setInterval(() => void refresh(), 5_000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const act = useCallback(async (route: string, init: RequestInit) => {
    setBusy(true);
    try {
      const room = await fetchRoom(route, init);
      setRooms((current) => {
        const others = current.filter((r) => r.id !== room.id);
        return [room, ...others];
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const createRoom = () => {
    const name = newName.trim();
    if (!name || busy) return;
    setNewName("");
    void act("/api/rooms", { method: "POST", body: JSON.stringify({ name, computerKind: newKind }) });
  };

  const join = (room: Room) => {
    void act(`/api/rooms/${room.id}/join`, {
      method: "POST",
      body: JSON.stringify({ kind: "human", id: human.current.id, name: human.current.name }),
    });
  };

  const leave = (room: Room) => {
    void act(`/api/rooms/${room.id}/leave`, {
      method: "POST",
      body: JSON.stringify({ memberId: human.current.id }),
    });
  };

  const close = (room: Room) => {
    setBusy(true);
    fetch(`/api/rooms/${room.id}`, { method: "DELETE" })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        setRooms((current) => current.filter((r) => r.id !== room.id));
        setError(null);
      })
      .catch((error: Error) => {
        setError(error.message);
        void refresh();
      })
      .finally(() => setBusy(false));
  };

  const renameSelf = (name: string) => {
    setHumanName(name);
    human.current = { id: human.current.id, name };
    localStorage.setItem(HUMAN_NAME_KEY, name);
  };

  return (
    <section className="rooms-panel" aria-label="Agent rooms">
      <header className="rooms-header">
        <span className="rooms-title">Rooms</span>
        <input
          className="rooms-self-name"
          value={humanName}
          onChange={(e) => renameSelf(e.target.value)}
          aria-label="Your display name"
          placeholder="Your name"
        />
      </header>

      <form
        className="rooms-new"
        onSubmit={(e) => {
          e.preventDefault();
          createRoom();
        }}
      >
        <input
          className="rooms-input"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New room name"
          aria-label="New room name"
        />
        <select
          className="rooms-select"
          value={newKind}
          onChange={(e) => {
            // SAFETY: every option's value is one of the three computer
            // kinds in the list above, matching Room["computerKind"].
            const kind = e.target.value as Room["computerKind"];
            setNewKind(kind);
          }}
          aria-label="Computer kind"
        >
          <option value="box">Box computer</option>
          <option value="localvm">Local VM</option>
          <option value="opensandbox">OpenSandbox</option>
        </select>
        <button type="submit" className="rooms-button rooms-button-primary" disabled={busy || !newName.trim()}>
          <Plus size={13} /> New room
        </button>
      </form>

      {error && <div className="rooms-error">{error}</div>}

      {rooms.length === 0 ? (
        <p className="rooms-empty">No rooms yet — create one to work alongside your bots.</p>
      ) : (
        <ul className="rooms-list">
          {rooms.map((room) => (
            <RoomRow
              key={room.id}
              room={room}
              selfId={human.current.id}
              busy={busy}
              onJoin={join}
              onLeave={leave}
              onClose={close}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
