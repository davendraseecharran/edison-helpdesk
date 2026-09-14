'use client';

/**
 * Voice, both directions, on what the browser already has.
 *
 * Recognition is `webkitSpeechRecognition || SpeechRecognition`, English,
 * with interim results so the words land in the composer as they are said.
 * The hook also opens the microphone through an `AudioContext` analyser to
 * read a level for the orb; when that is refused or unavailable a gentle
 * synthetic pulse stands in, so the orb still moves with the person's turn
 * to speak. Speaking uses `speechSynthesis` and is cancelled by any new
 * message and on unmount, so a reply never talks over the next one.
 *
 * None of this is a realtime API: no audio leaves the browser except to the
 * browser vendor's own recognition service, which is what the person agreed
 * to when they allowed the microphone.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionConstructor = new () => RecognitionLike;

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    webkitSpeechRecognition?: RecognitionConstructor;
    SpeechRecognition?: RecognitionConstructor;
  };
  return scope.webkitSpeechRecognition ?? scope.SpeechRecognition ?? null;
}

function subscribeToNothing(): () => void {
  return () => {};
}

/** Whether this browser can take dictation. False on the server and during hydration. */
export function useSpeechSupported(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => recognitionConstructor() !== null,
    () => false,
  );
}

export interface SpeechRecognitionHandle {
  supported: boolean;
  listening: boolean;
  /** Microphone level, 0 to 1, smoothed. Synthetic when the microphone cannot be analysed. */
  level: number;
  start: () => void;
  stop: () => void;
}

/**
 * Push-to-talk.
 *
 * `onInterim` receives the current utterance as it forms; `onFinal` receives
 * each finished utterance once. `onEnd` fires when recognition stops for any
 * reason, including the browser's own silence timeout.
 */
export function useSpeechRecognition({
  onInterim,
  onFinal,
  onEnd,
}: {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onEnd?: () => void;
}): SpeechRecognitionHandle {
  const supported = useSpeechSupported();
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);

  const recognition = useRef<RecognitionLike | null>(null);
  // The latest callbacks, for the recognition instance's own handlers.
  const handlers = useRef({ onInterim, onFinal, onEnd });
  useEffect(() => {
    handlers.current = { onInterim, onFinal, onEnd };
  });

  // Level reading: a media stream and analyser when allowed, a pulse when not.
  const audio = useRef<{
    frame: number;
    context: AudioContext | null;
    stream: MediaStream | null;
  } | null>(null);

  const stopLevel = useCallback(() => {
    const current = audio.current;
    if (!current) return;
    cancelAnimationFrame(current.frame);
    current.stream?.getTracks().forEach((track) => track.stop());
    void current.context?.close().catch(() => {});
    audio.current = null;
    setLevel(0);
  }, []);

  const startLevel = useCallback(async () => {
    stopLevel();
    const startedAt = performance.now();
    const state: NonNullable<typeof audio.current> = { frame: 0, context: null, stream: null };
    audio.current = state;

    let smoothed = 0;
    const synthetic = () => {
      if (audio.current !== state) return;
      const t = (performance.now() - startedAt) / 1000;
      // A slow swell with a quicker ripple on top: alive, never frantic.
      const value = 0.35 + 0.2 * Math.sin(t * 2.2) + 0.08 * Math.sin(t * 7.1);
      setLevel(Math.min(1, Math.max(0, value)));
      state.frame = requestAnimationFrame(synthetic);
    };

    try {
      const media = navigator.mediaDevices;
      if (!media?.getUserMedia || typeof AudioContext === 'undefined') throw new Error('no analyser');
      const stream = await media.getUserMedia({ audio: true });
      if (audio.current !== state) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      state.context = context;
      state.stream = stream;
      const samples = new Uint8Array(analyser.fftSize);

      const measure = () => {
        if (audio.current !== state) return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const centred = (samples[i] - 128) / 128;
          sum += centred * centred;
        }
        const rms = Math.sqrt(sum / samples.length);
        // Speech sits around 0.05 to 0.3 RMS; stretch that onto 0 to 1.
        const target = Math.min(1, rms * 3.5);
        smoothed += (target - smoothed) * (target > smoothed ? 0.5 : 0.12);
        setLevel(smoothed);
        state.frame = requestAnimationFrame(measure);
      };
      state.frame = requestAnimationFrame(measure);
    } catch {
      if (audio.current !== state) return;
      state.frame = requestAnimationFrame(synthetic);
    }
  }, [stopLevel]);

  const stop = useCallback(() => {
    recognition.current?.stop();
    // `onend` follows and clears the rest; the level stops at once so the orb
    // settles the moment the finger lifts.
    stopLevel();
  }, [stopLevel]);

  const start = useCallback(() => {
    const Recognition = recognitionConstructor();
    if (!Recognition || recognition.current) return;
    const instance = new Recognition();
    instance.lang = 'en-US';
    instance.interimResults = true;
    instance.continuous = true;

    instance.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) handlers.current.onFinal(transcript.trim());
        else interim += transcript;
      }
      if (interim.trim() !== '') handlers.current.onInterim(interim.trim());
    };
    instance.onerror = () => {
      // `onend` follows every error; nothing to add here. A refused
      // microphone simply ends the attempt, and the button is there to retry.
    };
    instance.onend = () => {
      recognition.current = null;
      setListening(false);
      stopLevel();
      handlers.current.onEnd?.();
    };

    try {
      instance.start();
    } catch {
      return;
    }
    recognition.current = instance;
    setListening(true);
    void startLevel();
  }, [startLevel, stopLevel]);

  useEffect(
    () => () => {
      recognition.current?.abort();
      recognition.current = null;
      stopLevel();
    },
    [stopLevel],
  );

  return { supported, listening, level, start, stop };
}

/** Markdown down to what should be said aloud. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' code omitted ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SpeakerHandle {
  supported: boolean;
  speaking: boolean;
  speak: (text: string) => void;
  cancel: () => void;
}

/** Reads text aloud with `speechSynthesis`. Cancels on unmount. */
export function useSpeaker(): SpeakerHandle {
  const supported = useSyncExternalStore(
    subscribeToNothing,
    () => typeof window !== 'undefined' && 'speechSynthesis' in window,
    () => false,
  );
  const [speaking, setSpeaking] = useState(false);

  const cancel = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      const spoken = speakableText(text);
      if (spoken === '') return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(spoken);
      utterance.lang = 'en-US';
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      setSpeaking(true);
      window.speechSynthesis.speak(utterance);
    },
    [],
  );

  useEffect(() => cancel, [cancel]);

  return { supported, speaking, speak, cancel };
}
