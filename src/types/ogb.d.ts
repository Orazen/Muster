// The narrow bridge the Electron preload exposes. Absent in the browser.


declare global {
  type DesktopCapabilities = {
    host: {
      platform: "darwin" | "linux" | "win32" | "other";
      /** The user's home folder, for showing paths as ~/… */
      homeDir?: string;
      label: string;
      session: "x11" | "wayland" | "headless" | "unknown";
      packaged: boolean;
    };
    windowChrome: "mac-inset" | "native";
    screenPreview: {
      available: boolean;
      interaction: "direct" | "portal-picker" | "none";
      reasonCode?: string;
    };
    dictation: {
      available: boolean;
      engine: "apple-speech" | "none";
      onDevice: boolean;
      reasonCode?: string;
    };
    localComputer: {
      available: boolean;
      support: "supported" | "limited" | "unsupported";
      reasonCode?: string;
    };
  };

  interface Window {
    ogb?: {
      platform: NodeJS.Platform;
      getCapabilities(): Promise<DesktopCapabilities>;
      /** Explicit opt-in to host computer control until this app quits. */
      enableComputerAccess?(): Promise<{ mode: string; reason?: string }>;
      /** Payload-free invalidation; read capabilities again after native setup settles. */
      onComputerAccessChanged?(listener: () => void): () => void;
      screenFrame(): Promise<string | null>;
      /** Start native dictation. Call mode supplies endpointMs so silence
       * finalizes a turn; composer dictation omits it and remains manual. */
      speechStart(options?: { endpointMs?: number }): Promise<void>;
      speechStop(): Promise<void>;
      /** Finish capture and emit the recognizer's final transcript. */
      speechFinish?(): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null; reason?: string }) => void): () => void;
      /** Absolute path of a dropped File ("" when the drag carried no
       * file on disk). Absent in older builds of the shell. */
      getPathForFile?(file: File): string;
      /** {mic} TCC status: granted|denied|not-determined|unknown. Screen
       * status is deliberately absent — macOS 15+ caches it per-process,
       * so it lies for the whole session after a grant. */
      permStatus(): Promise<{ mic: string }>;
      /** Triggers the macOS microphone prompt; resolves true when granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens System Settings on a privacy pane: mic|screen|speech|accessibility. */
      permOpenSettings(pane: "mic" | "screen" | "speech" | "accessibility"): Promise<void>;
      /** Copies an engine install command and opens a blank terminal. False
       * when no terminal could be launched; the clipboard still has it. */
      openInstallTerminal?(command: string): Promise<boolean>;
      /** Opens an http(s) link in the user's default browser. */
      openExternal?(url: string): Promise<boolean>;
      /** Opens the cloud sign-in start page in a small in-app window that
       * shares the app's cookie session, so the /oauth/finish handoff sets
       * its session cookie where the app can see it. Falls back to
       * openExternal in older shells or the web build. */
      openAuthHandoff?(url: string): Promise<boolean>;
      /** Native folder picker; resolves null when the user cancels. */
      pickFolder?(current?: string): Promise<string | null>;
      /** Save a provider credential through Electron's OS-backed store. */
      setCredential?(name: "composioApiKey", value: string): Promise<ConfigStatus>;
      /** Re-tint the Windows caption-button overlay to the active skin.
       * Absent in older shells; resolves false off Windows — treat both as
       * "nothing to do". */
      setTitleBarOverlay?(colors: { color: string; symbolColor: string }): Promise<boolean>;
      /** In-app auto-update (packaged app only; dormant in dev). onState
       * fires immediately with the current state, then on transitions. */
      updater?: {
        check(): Promise<void>;
        download(): Promise<void>;
        /** quit-and-install the downloaded update */
        install(): Promise<void>;
        onState(cb: (s: UpdaterState) => void): () => void;
      };
    };
  }
}

export interface UpdaterState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "installing"
    | "error";
  version?: string;
  percent?: number;
  message?: string;
  /** Set on macOS builds without Developer ID signing: no in-app restart
   * exists; the UI offers a direct download of the new release instead. */
  manualOnly?: boolean;
}
