"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { AudioLines, LoaderCircle } from "lucide-react";
import { motion } from "framer-motion";

export function VoiceButton({
  onTranscript,
  disabled,
}: {
  onTranscript: (text: string) => void | Promise<void>;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      // cleanup on unmount
      try {
        recorderRef.current?.stop();
      } catch {}
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const mr = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, {
          type: mr.mimeType || "audio/webm",
        });
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          const text = await api.transcribe(blob);
          if (text && text.trim()) await onTranscript(text.trim());
          else setError("No speech detected.");
        } catch (e) {
          setError(`STT failed: ${(e as Error).message}`);
        } finally {
          setTranscribing(false);
        }
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);
    } catch (e) {
      setError(`Mic unavailable: ${(e as Error).message}`);
    }
  }

  function stopRecording() {
    const mr = recorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.stop();
    }
    setRecording(false);
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => (recording ? stopRecording() : startRecording())}
        disabled={disabled || transcribing}
        title={recording ? "Tap to stop" : "Tap to talk"}
        aria-pressed={recording}
        className={
          "rounded-full w-12 h-12 flex items-center justify-center transition-all " +
          (recording
            ? "bg-peach-500 text-plum-950 mic-active"
            : transcribing
            ? "bg-white/10 text-cream/60"
            : "bg-white/10 text-peach-500 hover:bg-white/15 border border-peach-500/30")
        }
      >
        {transcribing ? (
          <LoaderCircle size={19} className="animate-spin" />
        ) : recording ? (
          <motion.span
            className="flex items-center gap-0.5"
            animate={{ scale: [1, 1.08, 1] }}
            transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
          >
            {[10, 18, 13, 21, 12].map((height, index) => (
              <motion.i
                key={height}
                className="block w-0.5 rounded-full bg-plum-950"
                animate={{ height: [height * 0.55, height, height * 0.65] }}
                transition={{ duration: 0.65, repeat: Infinity, delay: index * 0.08 }}
              />
            ))}
          </motion.span>
        ) : (
          <AudioLines size={21} strokeWidth={1.8} />
        )}
      </button>
      {error ? (
        <span className="text-xs text-red-300/80">{error}</span>
      ) : recording ? (
        <span className="text-xs text-peach-500 animate-pulse">listening…</span>
      ) : null}
    </div>
  );
}
