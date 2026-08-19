# Muster companion (Android)

Your bots keep running on the laptop. This is the phone you watch them from,
answer their approvals on, and send them the next thing.

## Status

React Native (Expo) app — mirrors the iOS companion's functionality:
pairing, roster, chat, streaming replies, approval cards, and computer view.

## Building

### Prerequisites

- Node 24+
- Expo CLI (`npm install -g expo-cli`)
- Android Studio (for emulator) or physical Android device

### Development

```sh
cd android-companion
pnpm install
npx expo start
```

Scan the QR code with Expo Go (Android) or press `a` for Android emulator.

### Build APK

```sh
npx expo build:android
```

### Build AAB (Play Store)

```sh
eas build --platform android --profile production
```

## Architecture

- **React Native + Expo** — shares logic with web companion
- **expo-secure-store** — pairing tokens in Android Keystore
- **expo-camera** — QR code scanning for pairing
- **@react-navigation** — native stack navigation
- **SSE parser** — handles raw event stream from harness

## Screens

- **Pairing** — enter address + code, or scan QR
- **ChatList** — roster of rooms with unread badges
- **ChatView** — transcript, approval cards, composer
- **Settings** — connection status, unpair

## What the phone may and may not do

Same as the iOS companion — read-only access to transcripts, send messages,
answer approvals. Cannot manage pairing, write API keys, or drive computers.

## Auto-update

Play Store handles updates automatically. Beta testing via internal track.
