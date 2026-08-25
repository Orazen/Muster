# Muster — PRD summary (frontend E2E)

Muster is a local-first desktop (Electron + React/Vite) app for running a team of AI agents ("bots") from a chat interface. Each bot has its own chat thread; bots can be messaged, reply via CLI engines (Claude Code, Codex, Gemini), and appear in a sidebar with busy/idle state.

## Key surfaces
- Sidebar: list of bots/groups, unread badges, create-bot flow.
- Chat view: message transcript per bot, composer to send messages, streaming replies, inspector toggle, find-in-conversation bar (Cmd/Ctrl+F).
- Rooms (GroupView): multi-agent group chat with members, bulletin pin.
- Settings modal: General (profile, team context brief), Engines, Connections, MCP, Computer.
- App loads at "/" with the sidebar + welcome/empty states when no bots exist.

## Critical user flows
1. App boots: UI renders, health OK, no console errors on load.
2. Create a new bot from the sidebar and see it in the list; open its chat.
3. Send a chat message in a bot conversation: the message appears immediately in the transcript (user bubble) — even before any engine replies.
4. Find bar: Cmd/Ctrl+F opens the find-in-conversation bar inside an open chat.
5. Settings open/close without breaking the current view.
6. Deep navigation between bots keeps each thread's transcript separate.

## Notes for testing
- No backend login required (local server, no auth by default).
- Sending a real message may not produce an engine reply if no CLI is configured — that's acceptable; assert only that the sent message renders.
