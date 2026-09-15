// The browser's own speech recognizer (Chrome, Edge, Safari). Declared
// structurally and minimally — only the shape server-free dictation uses.
// Absent in browsers without the API; the adapter treats that as "none".

declare global {
  interface WebSpeechAlternative {
    transcript: string;
    confidence: number;
  }
  interface WebSpeechResult {
    isFinal: boolean;
    length: number;
    [index: number]: WebSpeechAlternative;
  }
  interface WebSpeechResultList {
    length: number;
    [index: number]: WebSpeechResult;
  }
  interface WebSpeechEvent {
    resultIndex: number;
    results: WebSpeechResultList;
  }
  interface WebSpeechErrorEvent {
    error: string;
  }
  interface WebSpeechRecognitionLike {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start(): void;
    stop(): void;
    abort(): void;
    onresult: ((event: WebSpeechEvent) => void) | null;
    onerror: ((event: WebSpeechErrorEvent) => void) | null;
    onend: (() => void) | null;
  }
  type WebSpeechCtor = new () => WebSpeechRecognitionLike;

  interface Window {
    SpeechRecognition?: WebSpeechCtor;
    webkitSpeechRecognition?: WebSpeechCtor;
  }
}

export {};
