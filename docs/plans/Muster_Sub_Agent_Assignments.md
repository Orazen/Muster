# Muster Sub-Agent Assignments

This file assigns the first focused work packages for the Muster MVP.

All agents must use `docs/plans/Muster_MVP_Master_Plan.md` as the source of truth.

## Operating Rule

Do not expand the product scope.

Every agent must help the first MVP prove this:

**User can log in, connect Google Drive, chat with Muster, save memory, and restore everything from Drive.**

## Reporting Rule

Each agent must report back with:

1. What was completed
2. What files were changed or proposed
3. What decisions are needed from Tharun
4. What risks or blockers exist
5. Recommended next action

The report should be short, practical, and ready for CTO review.

## Agent 1: UI and Brand System

### Mission

Create the first practical UI and brand system for Muster.

### Deliverables

- Logo direction
- Color palette
- Typography
- Mobile layout
- Desktop layout
- Home screen
- Chat screen
- Settings screen
- Google Drive connection screen

### Prompt

```txt
You are Agent 1 for Muster.

Read docs/plans/Muster_MVP_Master_Plan.md first.

Your task is to create the first practical UI and brand system for Muster, a private AI companion ecosystem.

Focus only on the MVP:
- login
- Google Drive connection
- chat
- memory
- restore
- settings

Do not overdesign. Do not add social features, hardware flows, or full OS concepts yet.

Return a report with:
1. completed UI/brand recommendations
2. proposed screens
3. implementation notes
4. risks/blockers
5. next action
```

## Agent 2: Google Drive Storage Architecture

### Mission

Design how Muster stores and restores user data from Google Drive.

### Deliverables

- Folder structure
- File names
- JSON schemas
- Sync rules
- Backup strategy
- Conflict handling
- Restore flow

### Prompt

```txt
You are Agent 2 for Muster.

Read docs/plans/Muster_MVP_Master_Plan.md first.

Your task is to design the Google Drive storage architecture for the first Muster MVP.

Muster must store:
- soul.md
- memory.json
- sessions.json
- tasks.json
- settings.json
- backups

Focus on practical implementation. Define exact schemas and sync behavior.

Return a report with:
1. proposed Drive folder structure
2. JSON schemas
3. save/restore flow
4. conflict handling
5. risks/blockers
6. next action
```

## Agent 3: Soul and Memory Rules

### Mission

Create Muster's first personality file and memory behavior.

### Deliverables

- `soul.md`
- Memory rules
- What to remember
- What not to remember
- Session summary behavior
- Memory update rules

### Prompt

```txt
You are Agent 3 for Muster.

Read docs/plans/Muster_MVP_Master_Plan.md first.

Your task is to create the first version of soul.md and the memory rules for Muster.

Muster should be:
- calm
- loyal
- practical
- honest
- emotionally aware
- focused on helping the user finish real work

Keep the system simple. Do not create complex AGI mythology or overbuilt personality layers.

Return a report with:
1. proposed soul.md
2. memory save rules
3. memory ignore rules
4. session summary rules
5. risks/blockers
6. next action
```

## Agent 4: Muster Charm Hardware Research

### Mission

Research future hardware options without distracting from the software MVP.

### Deliverables

- Waveshare ESP32-S3 Touch AMOLED 1.75 review
- Cheaper ESP32 alternatives
- Mic/speaker options
- Battery options
- Local vs server/phone processing split
- Estimated testing cost

### Prompt

```txt
You are Agent 4 for Muster.

Read docs/plans/Muster_MVP_Master_Plan.md first.

Your task is to research practical hardware options for a future Muster Charm pocket/keychain device.

Compare:
- Waveshare ESP32-S3 Touch AMOLED 1.75-inch board
- cheaper ESP32 boards for testing
- mic/speaker/battery add-ons

Important: hardware is not the first MVP. Your job is research only.

Return a report with:
1. recommended test hardware
2. rough cost
3. what can run locally
4. what must run on phone/server/web app
5. risks/blockers
6. next action
```

## Agent 5: Security and Privacy Review

### Mission

Review the MVP for practical privacy and security risks.

### Deliverables

- Auth risk checklist
- Google Drive permission risk checklist
- Token storage rules
- Data privacy rules
- Encryption suggestions
- MVP-safe security checklist

### Prompt

```txt
You are Agent 5 for Muster.

Read docs/plans/Muster_MVP_Master_Plan.md first.

Your task is to review security and privacy risks for the first Muster MVP.

Muster uses:
- email code login
- Google Sign-In
- Google Drive storage
- soul.md
- memory.json
- sessions.json
- tasks.json
- settings.json

Keep recommendations practical for a 7-day MVP. Do not overcomplicate.

Return a report with:
1. critical security risks
2. Drive permission recommendations
3. token storage rules
4. simple privacy checklist
5. must-fix items before demo
6. next action
```

## CTO Review Loop

After each agent reports:

1. Check whether the output supports the MVP.
2. Reject anything that adds unnecessary scope.
3. Convert useful recommendations into tasks.
4. Keep the build focused on login, Drive sync, chat, memory, and restore.

## Founder Instruction

Tharun owns the product direction.

Agents provide narrow work.

CTO review keeps the system practical.
