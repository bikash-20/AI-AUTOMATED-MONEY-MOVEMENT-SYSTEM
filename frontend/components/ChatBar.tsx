"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { VoiceButton } from "./VoiceButton";
import { ArrowUp } from "lucide-react";
import { speakText } from "@/lib/speech";

export type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
};

let _id = 0;
const nextId = () => ++_id;

export function ChatBar({
  userId,
  onCommand,
  disabled,
  placeholder = "Say something, e.g. 'send 500 to rishad'",
}: {
  userId: number;
  onCommand: (text: string) => Promise<{ text: string } | null>; // command to /agent/act
  disabled?: boolean;
  placeholder?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Auto-scroll on new message.
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  async function sendText(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy || disabled) return;
    setInput("");
    const userMsg: ChatMessage = { id: nextId(), role: "user", text: trimmed };
    setMessages((m) => [...m, userMsg]);
    setBusy(true);

    // First, classify whether this is a money command or small talk.
    const norm = trimmed.toLowerCase();
    const isCommand =
      /\b(send|transfer|pay|request|split|balance|history|hi|hello|hey|greetings)\b/.test(
        norm
      ) && /\d/.test(norm)
        ? true
        : /^\s*(send|transfer|pay|request|split|balance|history)\b/.test(norm);

    if (isCommand) {
      // Defer to the orchestrator and show a thinking reply.
      const think: ChatMessage = {
        id: nextId(),
        role: "assistant",
        text: "…",
        pending: true,
      };
      setMessages((m) => [...m, think]);
      try {
        const response = await onCommand(trimmed);
        if (response?.text) speakText(response.text);
        setMessages((m) =>
          m.map((x) =>
            x.id === think.id
              ? { ...x, text: response?.text || "I couldn't complete that request." }
              : x
          )
        );
      } catch (e) {
        setMessages((m) =>
          m.map((x) =>
            x.id === think.id
              ? { ...x, text: `Couldn't reach the assistant: ${(e as Error).message}` }
              : x
          )
        );
      } finally {
        setBusy(false);
      }
      return;
    }

    // Pure chat — use the conversational endpoint.
    try {
      const r = await api.agentChat({ user_id: userId, text: trimmed });
      speakText(r.text);
      setMessages((m) => [
        ...m,
        { id: nextId(), role: "assistant", text: r.text },
      ]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          id: nextId(),
          role: "assistant",
          text: `Couldn't reach the assistant: ${(e as Error).message}`,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    sendText(input);
  }

  function onVoice(transcript: string) {
    if (!transcript) return;
    sendText(transcript);
  }

  return (
    <div className="glass rounded-2xl p-4 flex flex-col gap-3">
      {/* Thread */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-[120px] max-h-72 overflow-y-auto pr-1 flex flex-col gap-2"
      >
        {messages.length === 0 ? (
          <div className="text-xs text-secondary text-center py-8">
            Say hi, ask for your balance, or run a money command.
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={
                "rounded-xl px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap " +
                (m.role === "user"
                  ? "self-end bg-peach-500/20 text-cream"
                  : "self-start bg-white/5 text-cream/90")
              }
            >
              {m.role === "assistant" && !m.pending ? (
                <span>
                  <span className="text-peach-500/80 text-xs uppercase tracking-wider mr-2">
                    wallet
                  </span>
                  {m.text}
                </span>
              ) : (
                m.text
              )}
            </div>
          ))
        )}
      </div>

      {/* Input row */}
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          disabled={busy || disabled}
          className="flex-1 bg-white/5 border border-white/10 rounded-full px-4 py-2.5 text-sm text-cream placeholder:text-secondary focus:outline-none focus:border-peach-500/50"
        />
        <VoiceButton
          disabled={busy || disabled}
          onTranscript={onVoice}
        />
        <button
          type="submit"
          disabled={busy || disabled || !input.trim()}
          className="btn-peach rounded-full px-4 py-2.5 text-sm font-semibold disabled:opacity-40 flex items-center gap-1.5"
        >
          Send <ArrowUp size={15} strokeWidth={2.2} />
        </button>
      </form>
    </div>
  );
}
