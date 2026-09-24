"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { VoiceButton } from "./VoiceButton";
import { ArrowUp } from "lucide-react";
import { speakText, subscribeSpeaking } from "@/lib/speech";

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
  const [speaking, setSpeaking] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return subscribeSpeaking(setSpeaking);
  }, []);

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
    // The bar is: an orchestrator command needs a real money/ledger signal
    // — either a movement verb sitting next to a digit ("send 300 to srijan"),
    // or the bare ledger keywords "balance" / "history". Phrases like
    // "request help", "pay attention", "send me a joke", "split the bill"
    // are small talk and go to /agent/chat.
    const norm = trimmed.toLowerCase();
    const hasDigit = /\d/.test(norm);
    const movementVerb = /\b(send|transfer|pay|request|split)\b/.test(norm);
    // Allow short ledger phrases like "balance?", "show my history", "balance
    // please" — but not "history of rome" (a general knowledge question).
    const ledgerKeyword =
      /^\s*(balance|history)\b/.test(norm) &&
      !/\b(history of|balance sheet)\b/.test(norm);
    const isCommand = (movementVerb && hasDigit) || ledgerKeyword;

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

  // While the bot is speaking, the mic must be disabled to avoid the
  // bot's own audio being transcribed as a new user command.
  const micDisabled = busy || disabled || speaking;

  return (
    // The card itself has a fixed max-height so it never grows past
    // ~22rem no matter how long the thread gets. The thread scrolls
    // inside; the input row stays pinned at the bottom. This keeps
    // the dashboard layout stable as the conversation lengthens.
    <div className="glass rounded-2xl p-4 flex flex-col gap-3 max-h-[22rem] min-h-[16rem]">
      {/* Thread */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-2"
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
          disabled={micDisabled}
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