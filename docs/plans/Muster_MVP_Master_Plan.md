# Muster MVP Master Plan

## 1. Vision

Muster is a private AI companion ecosystem built by Tharun.

Muster helps the user think, remember, plan, and act across devices while keeping personal data under the user's control.

The long-term vision includes:

- Muster Chatbot
- Muster OS
- Muster Social
- Muster Charm hardware
- User-owned memory and sessions
- Google Drive based storage
- Low server dependency
- Personal AI identity through `soul.md`

The first version should be simple, stable, and useful.

## 2. First MVP Goal

The first MVP should prove one core idea:

**A user can log in, connect Google Drive, chat with Muster, save memories, and restore everything later from their own Drive.**

The MVP must support:

- Email code login
- Google Sign-In
- Google Drive connection
- Automatic `Muster` folder creation
- Chat interface
- Session saving
- Memory saving
- Restore on refresh
- Restore on another browser/device
- `soul.md` personality file

## 3. Core MVP Files

Inside the user's Google Drive, create this structure:

```txt
Muster/
  soul.md
  memory.json
  sessions.json
  tasks.json
  settings.json
  backups/
```

### `soul.md`

Purpose: Defines Muster's identity, personality, behavior, and rules.

Example:

```md
# Muster Soul

## Identity
You are Muster, a private personal AI companion built by Tharun.

## Personality
Calm, loyal, practical, emotionally aware, and honest.

## Rules
1. User owns all data.
2. Do not overpromise.
3. Save useful memories only.
4. Help the user continue from where they stopped.
5. Focus on real-world execution.
```

### `memory.json`

Purpose: Stores long-term user memories.

Stores:

- User preferences
- Important projects
- Decisions
- Personal context
- Repeated work patterns

### `sessions.json`

Purpose: Stores chat history.

Stores:

- Session ID
- Date/time
- User messages
- Assistant responses
- Related memories
- Task references

### `tasks.json`

Purpose: Stores user tasks and agent actions.

Stores:

- Task title
- Status
- Priority
- Deadline
- Assigned agent
- Notes

### `settings.json`

Purpose: Stores user preferences.

Stores:

- Language
- Theme
- AI model preference
- Sync settings
- Privacy settings

## 4. Main User Flow

1. User opens Muster.
2. User logs in with email code or Google.
3. User connects Google Drive.
4. Muster creates the `Muster` folder.
5. Muster checks if core files exist.
6. If files do not exist, Muster creates them.
7. User starts chatting.
8. Chat is saved into `sessions.json`.
9. Important facts are saved into `memory.json`.
10. On refresh or another device, Muster restores everything from Drive.

## 5. Tharun's Main Task

Tharun should focus only on the core build first:

- Authentication
- Google Drive connection
- Folder creation
- File creation
- Chat screen
- Save chat session
- Save memory
- Restore data

Do not start hardware yet.

Do not start social features yet.

Do not build full OS yet.

First make the core system work.

## 6. Sub-Agent Assignments

### Agent 1: UI and Brand System

Task:

Create the first visual system for Muster.

Deliverables:

- Logo direction
- Color palette
- Typography
- Mobile layout
- Desktop layout
- Home screen
- Chat screen
- Settings screen
- Drive connection screen

Prompt:

```txt
You are designing the first UI and brand system for Muster, a private AI companion ecosystem.

Create a practical MVP design system. Focus on a clean chat interface, Google Drive connection flow, memory screen, and settings screen.

Do not overdesign. Keep it simple, modern, and buildable in 7 days.
```

### Agent 2: Google Drive Storage Architecture

Task:

Design how Muster stores user data in Google Drive.

Deliverables:

- Folder structure
- File names
- JSON schemas
- Sync rules
- Backup strategy
- Conflict handling
- Restore flow

Prompt:

```txt
Design the Google Drive storage architecture for Muster MVP.

Muster stores user memory, sessions, tasks, settings, and soul.md inside the user's Google Drive.

Give exact folder structure, JSON schemas, sync rules, backup strategy, and restore flow.

Keep it practical for a first MVP.
```

### Agent 3: Soul and Memory Rules

Task:

Create the first version of Muster's personality and memory behavior.

Deliverables:

- `soul.md`
- Memory rules
- What to remember
- What not to remember
- How to update memory
- How to summarize sessions

Prompt:

```txt
Create the first soul.md and memory rules for Muster.

Muster is a private AI companion built by Tharun. It should be calm, practical, honest, emotionally aware, and focused on helping the user finish real work.

Define identity, personality, core rules, memory rules, and session summary behavior.
```

### Agent 4: Muster Charm Hardware Research

Task:

Research hardware for the future Muster Charm device.

Deliverables:

- Best ESP32 board options
- Waveshare ESP32-S3 Touch AMOLED review
- Mic/speaker options
- Battery options
- What can run locally
- What must run on phone/server
- Estimated cost

Prompt:

```txt
Research hardware options for a future Muster Charm pocket/keychain AI companion device.

Compare Waveshare ESP32-S3 Touch AMOLED 1.75-inch board and cheaper ESP32 alternatives.

Focus on what is possible for MVP testing: display, mic, speaker, battery, Wi-Fi, Bluetooth, touch UI, and connection to Muster web/mobile app.
```

### Agent 5: Security and Privacy Review

Task:

Check risks in the MVP.

Deliverables:

- Auth risks
- Google Drive permission risks
- Token storage rules
- Data privacy rules
- Encryption suggestions
- MVP-safe security checklist

Prompt:

```txt
Review the security and privacy risks for Muster MVP.

Muster uses login, Google Sign-In, Google Drive storage, memory.json, sessions.json, tasks.json, settings.json, and soul.md.

Give a practical MVP security checklist. Do not overcomplicate, but make sure user data is protected.
```

## 7. Seven-Day MVP Plan

### Day 1: Document and Architecture

- Finish this master plan
- Finalize core files
- Finalize user flow
- Assign sub-agents

### Day 2: Auth Setup

- Email code login
- Google Sign-In
- Basic user session

### Day 3: Google Drive Connection

- Connect Drive
- Create `Muster` folder
- Create core files

### Day 4: Chat Screen

- Build chat UI
- Send and receive messages
- Save messages to `sessions.json`

### Day 5: Memory System

- Save important facts to `memory.json`
- Load memory into chat
- Add simple memory view

### Day 6: Restore and Sync

- Refresh restore
- Login from another browser
- Load previous sessions
- Test file updates

### Day 7: Polish and Demo

- Fix bugs
- Improve UI
- Add settings
- Record demo
- Prepare next roadmap

## 8. Strict MVP Rules

- Do not overbuild.
- Do not start hardware before software MVP.
- Do not build social features yet.
- Do not build full OS yet.
- Do not add too many models.
- Do not make complex agent systems first.
- Make login, Drive sync, chat, memory, and restore perfect first.

## 9. CEO/CTO Advisor Workflow

Use this workflow when planning Muster:

1. Founder decides the product direction.
2. CEO view checks market value, simplicity, and user need.
3. CTO view checks technical risk, architecture, and build order.
4. Agents receive narrow tasks with clear deliverables.
5. No agent should invent a bigger product than the MVP.
6. Every task must connect back to the first working demo.

Decision rule:

**If a feature does not help login, Drive sync, chat, memory, or restore, it waits for later.**

## 10. Success Definition

The MVP is successful when:

- User can log in.
- User can connect Google Drive.
- Muster creates its folder and files.
- User can chat.
- Chat history is saved.
- Memory is saved.
- Refresh does not lose data.
- Another browser can restore the same data.
- `soul.md` controls the assistant personality.

If this works, Muster has a real foundation.
