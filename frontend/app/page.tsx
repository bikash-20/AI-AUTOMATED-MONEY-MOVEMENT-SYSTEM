"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { AgentActResponse, FaceStatus, HistoryResponse, PendingRequest, User, api } from "@/lib/api";
import { newIdempotencyKey } from "@/lib/idempotency";
import { clearActiveUserId, readActiveUserId, writeActiveUserId } from "@/lib/session";
import { SessionSwitcher } from "@/components/SessionSwitcher";
import { BalanceCard } from "@/components/BalanceCard";
import { SendForm } from "@/components/SendForm";
import { ReviewCard } from "@/components/ReviewCard";
import { HistoryList } from "@/components/HistoryList";
import { PendingRequests } from "@/components/PendingRequests";
import { VoiceButton } from "@/components/VoiceButton";
import { VoiceOrb } from "@/components/VoiceOrb";
import { ChatBar } from "@/components/ChatBar";
import { SplitForm } from "@/components/SplitForm";
import { SavingsGoals } from "@/components/SavingsGoals";
import { AnimatePresence, motion } from "framer-motion";
import { HandCoins, LogOut, Scan, ShieldCheck, Settings as SettingsIcon } from "lucide-react";
import { speakText, subscribeSpeaking } from "@/lib/speech";
import { useVoiceLoop } from "@/hooks/useVoiceLoop";

const BalanceChart = dynamic(
  () => import("@/components/BalanceChart").then((module) => module.BalanceChart),
  {
    ssr: false,
    loading: () => <div className="h-48 animate-pulse rounded-xl bg-white/5" />,
  }
);
const SettingsModal = dynamic(
  () => import("@/components/SettingsModal").then((module) => module.SettingsModal),
  { ssr: false }
);
const FaceIDConfirm = dynamic(
  () =>
    import("@/components/FaceIDConfirm").then((m) => m.FaceIDConfirm),
  { ssr: false }
);

export default function DashboardPage() {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [reviewResp, setReviewResp] = useState<AgentActResponse | null>(null);
  // Use a ref (not state) so handleConfirm / handleDecline always read the
  // freshest key, even if a new sendIntent call lands before the previous
  // render commits. Stored on the reviewResp itself is fine too, but a ref
  // keeps the wire shape untouched.
  const pendingKeyRef = useRef<string | null>(null);
  const [working, setWorking] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [askRecipient, setAskRecipient] = useState("");
  const [askAmount, setAskAmount] = useState("");
  const [askNote, setAskNote] = useState("");
  const [splitOpen, setSplitOpen] = useState(false);

  // Face ID state. `faceStatus` reflects the SERVER's view (used for the
  // header indicator and to decide whether FaceIDConfirm should open).
  // The localStorage copy is checked inside FaceIDConfirm itself when it
  // needs the stored vector to score against.
  const [faceStatus, setFaceStatus] = useState<FaceStatus | null>(null);
  const [faceConfirmOpen, setFaceConfirmOpen] = useState(false);

  // Bot speaking flag — used to disable the mic so the bot's own audio
  // isn't picked up as a new user command. Source of truth lives in
  // lib/speech.ts; we mirror it locally for JSX.
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => subscribeSpeaking(setSpeaking), []);

  // Auth gate: redirect to /login if no session.
  useEffect(() => {
    const saved = readActiveUserId();
    if (saved === null) {
      router.replace("/login");
      return;
    }
    setActiveId(saved);
    setAuthChecked(true);
  }, [router]);

  // Load users after auth check.
  useEffect(() => {
    if (!authChecked) return;
    api.listUsers().then((u) => {
      setUsers(u);
      if (activeId !== null && !u.some((x) => x.id === activeId)) {
        clearActiveUserId();
        router.replace("/login");
      }
    });
  }, [authChecked, activeId, router]);

  // Load data when active user changes.
  const refresh = useCallback(async () => {
    if (activeId === null) return;
    const [h, r] = await Promise.all([
      api.getHistory(activeId),
      api.getRequests(activeId),
    ]);
    setHistory(h);
    setRequests(r);
  }, [activeId]);

  useEffect(() => {
    if (activeId !== null) {
      refresh().catch((e) => setToast(`Load failed: ${(e as Error).message}`));
      writeActiveUserId(activeId);
      // Refresh Face ID status alongside everything else. Non-fatal —
      // an enrollment could have been added or removed on another tab.
      api
        .getFaceStatus(activeId)
        .then(setFaceStatus)
        .catch(() => setFaceStatus({ user_id: activeId, enrolled: false, enrolled_at: null }));
    }
  }, [activeId, refresh]);

  // ---- Voice system -------------------------------------------------------
  // The voice loop owns its own lifecycle. It activates once activeId is
  // known and runs the wake-word → STT → /agent/act → confirm pipeline.
  // After every voice-initiated action, refresh() so the UI reflects the
  // new balance/history.
  useVoiceLoop(activeId ?? 0, () => { refresh().catch(() => {}); });

  // Toast auto-dismiss.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const activeUser = useMemo(
    () => users.find((u) => u.id === activeId) ?? null,
    [users, activeId]
  );

  const recipientHandles = useMemo(
    () =>
      users.filter((u) => u.id !== activeId).map((u) => u.handle),
    [users, activeId]
  );

  // Helper: speak `text`, surfacing backend TTS failures as a toast.
  // We do NOT silently fall back to a browser-default voice — that was
  // the original bug.
  const safeSpeak = useCallback((text: string) => {
    speakText(text, {
      onError: (err) => setToast(`Voice reply failed: ${err.message}`),
    });
  }, []);

  // ---- Send (manual form) -----------------------------------------------
  async function handleSend({
    recipient,
    amount,
    note,
  }: {
    recipient: string;
    amount: string;
    note: string;
  }) {
    if (!activeId) return;
    setWorking(true);
    setReviewResp(null);
    try {
      const key = newIdempotencyKey();
      pendingKeyRef.current = key;
      // Direct, LLM-free send. No Ollama round-trip, no regex parser
      // racing with structured input. The chat/voice paths still flow
      // through /agent/act untouched.
      const resp = await api.agentActSend({
        user_id: activeId,
        recipient_handle: recipient,
        amount_bdt: amount,
        note: note || undefined,
        idempotency_key: key,
      });
      if (resp.card && resp.pending_id) {
        setReviewResp(resp);
      } else {
        setToast(resp.text);
        safeSpeak(resp.text);
      }
    } catch (e) {
      const message = `Error: ${(e as Error).message}`;
      setToast(message);
      safeSpeak("I could not complete that send.");
    } finally {
      setWorking(false);
    }
  }

  // ---- Send (via voice transcript / chat input) -------------------------
  async function sendIntent(text: string): Promise<AgentActResponse | null> {
    if (!activeId) return null;
    setWorking(true);
    setReviewResp(null);
    try {
      const key = newIdempotencyKey();
      pendingKeyRef.current = key;
      const resp = await api.agentAct({ user_id: activeId, text, idempotency_key: key });
      if (resp.card && resp.pending_id) {
        setReviewResp(resp);
        // No auto-engagement of the mic. The review card carries its
        // own inline mic button that the user taps if they want to
        // confirm by voice.
      } else {
        setToast(resp.text);
        safeSpeak(resp.text);
      }
      return resp;
    } catch (e) {
      const message = `Error: ${(e as Error).message}`;
      setToast(message);
      safeSpeak("I could not complete that request.");
      return null;
    } finally {
      setWorking(false);
    }
  }

  async function handleConfirm() {
    if (!reviewResp || !reviewResp.pending_id || !activeId) return;
    // If this user has enrolled a face, gate the confirm on a successful
    // Face ID match. If not enrolled, fall through to the regular
    // confirm — the demo is intentionally non-blocking.
    if (faceStatus?.enrolled) {
      setFaceConfirmOpen(true);
      return;
    }
    await confirmAfterFaceID();
  }

  async function confirmAfterFaceID() {
    if (!reviewResp || !reviewResp.pending_id || !activeId) return;
    const pendingKey = pendingKeyRef.current;
    if (!pendingKey) return;
    setFaceConfirmOpen(false);
    setWorking(true);
    try {
      const r = await api.agentConfirm({
        user_id: activeId,
        pending_id: reviewResp.pending_id,
        idempotency_key: pendingKey,
        decision: "confirm",
      });
      setReviewResp(null);
      pendingKeyRef.current = null;
      setToast(r.text);
      safeSpeak(r.text);
      await refresh();
    } catch (e) {
      setToast(`Confirm failed: ${(e as Error).message}`);
      safeSpeak("I could not confirm that transfer.");
    } finally {
      setWorking(false);
    }
  }

  async function handleDecline() {
    if (!reviewResp || !reviewResp.pending_id || !activeId) return;
    const pendingKey = pendingKeyRef.current;
    if (!pendingKey) return;
    setWorking(true);
    try {
      const r = await api.agentConfirm({
        user_id: activeId,
        pending_id: reviewResp.pending_id,
        idempotency_key: pendingKey,
        decision: "decline",
      });
      setReviewResp(null);
      pendingKeyRef.current = null;
      setToast(r.text);
      safeSpeak(r.text);
      await refresh();
    } catch (e) {
      setToast(`Cancel failed: ${(e as Error).message}`);
      safeSpeak("I could not cancel that transfer.");
    } finally {
      setWorking(false);
    }
  }

  // Voice transcript handler. Routes transcripts based on context:
  //   - If a review card is up → strict yes/no dispatch (anything else
  //     silently ignored — protects against bot-tail audio, ambient
  //     chatter, accidental taps).
  //   - Otherwise → run as a new intent through sendIntent.
  async function onVoiceTranscript(t: string) {
    const norm = t.toLowerCase().trim();
    const affirmative = /\b(yes|yeah|yep|sure|ok|okay|confirm|do it|haan|জি|কর|করো|হ্যাঁ)\b/.test(norm);
    const negative = /\b(no|nope|cancel|stop|nah|না|বাদ|না কর)\b/.test(norm);

    if (reviewResp) {
      if (affirmative) {
        await handleConfirm();
        return;
      }
      if (negative) {
        await handleDecline();
        return;
      }
      // Strict yes/no — silently drop anything else while a card is up.
      return;
    }

    setToast(`Heard: "${t}"`);
    const response = await sendIntent(t);
    if (response?.text) safeSpeak(response.text);
  }

  // ---- Pay a request ----------------------------------------------------
  async function payRequest(id: number) {
    if (!activeId) return;
    setWorking(true);
    try {
      const r = await api.payRequest(id, newIdempotencyKey(), activeId);
      setToast(`Paid. New balance: ৳${Number(r.new_balance_bdt).toLocaleString("en-IN")}`);
      await refresh();
    } catch (e) {
      setToast(`Pay failed: ${(e as Error).message}`);
    } finally {
      setWorking(false);
    }
  }

  async function declineRequest(id: number) {
    if (!activeId) return;
    setWorking(true);
    try {
      await api.declineRequest(id);
      setToast("Request declined.");
      await refresh();
    } catch (e) {
      setToast(`Decline failed: ${(e as Error).message}`);
    } finally {
      setWorking(false);
    }
  }

  // ---- Ask for money (request flow) -------------------------------------
  async function handleAsk() {
    if (!askRecipient || !askAmount || !activeId) {
      setToast("Pick someone and enter an amount.");
      return;
    }
    setAskOpen(false);
    setWorking(true);
    try {
      const key = newIdempotencyKey();
      // Direct, LLM-free request creation. Same shape as Quick-send.
      const resp = await api.agentActRequest({
        user_id: activeId,
        payer_handle: askRecipient,
        amount_bdt: askAmount,
        note: askNote || undefined,
        idempotency_key: key,
      });
      setToast(resp.text);
      safeSpeak(resp.text);
      setAskAmount("");
      setAskNote("");
    } catch (e) {
      setToast(`Ask failed: ${(e as Error).message}`);
      safeSpeak("I could not send that request.");
    } finally {
      setWorking(false);
    }
  }

  async function handleSplit({ recipients, amount }: { recipients: string[]; amount: string }) {
    if (!activeId) return;
    if (recipients.length < 2) {
      setToast("Pick at least two people.");
      return;
    }
    setSplitOpen(false);
    setWorking(true);
    setReviewResp(null);
    try {
      const key = newIdempotencyKey();
      pendingKeyRef.current = key;
      // N-way split goes through the explicit endpoint — no LLM
      // round-trip, no regex parser racing with chip-array input. Voice
      // and text splits still flow through sendIntent / /agent/act.
      const resp = await api.agentActSplit({
        user_id: activeId,
        recipient_handles: recipients,
        amount_bdt: amount,
        idempotency_key: key,
      });
      if (resp.card && resp.pending_id) {
        setReviewResp(resp);
      } else {
        setToast(resp.text);
        safeSpeak(resp.text);
      }
    } catch (e) {
      const message = `Error: ${(e as Error).message}`;
      setToast(message);
      safeSpeak("I could not complete that split.");
    } finally {
      setWorking(false);
    }
  }

  if (!authChecked || !activeUser || activeId === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-cream/70 text-sm">Loading demo…</div>
      </div>
    );
  }

  function handleLogout() {
    clearActiveUserId();
    router.push("/login");
  }

  // Header mic is disabled while the bot is talking OR while the agent
  // is busy. The mic button only ever arms via an explicit user tap.
  const headerMicDisabled = working || speaking;

  return (
    <motion.div
      className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto"
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: 0.07 } },
      }}
    >
      {/* Header */}
      <motion.header
        className="flex flex-wrap items-center justify-between gap-4 mb-6"
        variants={{ hidden: { opacity: 0, y: -12 }, visible: { opacity: 1, y: 0 } }}
        transition={{ duration: 0.45, ease: "easeOut" }}
      >
        <div>
          <h1 className="text-2xl font-bold text-cream tracking-tight">
            Wallet
            <span className="text-peach-500">.</span>
          </h1>
          <p className="text-xs text-secondary mt-0.5">
            Digital AI money movement platform
          </p>
        </div>
        <SessionSwitcher users={users} currentId={activeId} onChange={setActiveId} />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAskOpen(true)}
            title="Ask someone for money"
            className="btn-ghost rounded-full px-3.5 py-2 flex items-center gap-2 text-sm font-medium"
          >
            <HandCoins size={17} strokeWidth={1.8} />
            <span>Request money</span>
          </button>
          {faceStatus ? (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              title={
                faceStatus.enrolled
                  ? "Face ID enrolled — click to manage"
                  : "Face ID not enrolled — click to set up"
              }
              className={
                "btn-ghost rounded-full w-10 h-10 flex items-center justify-center text-sm " +
                (faceStatus.enrolled ? "ring-1 ring-mint-400/40" : "")
              }
              data-testid="face-id-indicator"
            >
              {faceStatus.enrolled ? (
                <ShieldCheck
                  size={17}
                  strokeWidth={1.8}
                  className="text-mint-400"
                />
              ) : (
                <Scan size={17} strokeWidth={1.8} className="text-cream/60" />
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            className="btn-ghost rounded-full w-10 h-10 flex items-center justify-center text-sm"
          >
            <SettingsIcon size={17} strokeWidth={1.8} />
          </button>
          <VoiceButton
            disabled={headerMicDisabled}
            onTranscript={onVoiceTranscript}
          />
          <button
            type="button"
            onClick={handleLogout}
            title="Sign out"
            className="btn-ghost rounded-full w-10 h-10 flex items-center justify-center text-sm"
          >
            <LogOut size={17} strokeWidth={1.8} />
          </button>
        </div>
      </motion.header>

      {/* Top row: balance + send + pending requests */}
      <motion.div
        className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4"
        variants={{ hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <BalanceCard
          userId={activeUser.id}
          displayName={activeUser.display_name}
          phone={activeUser.phone}
        />
        <div className="glass rounded-2xl p-6">
          <div className="text-secondary text-sm font-medium uppercase tracking-wider mb-4">
            Quick send
          </div>
          <SendForm
            recipients={recipientHandles}
            onSubmit={handleSend}
            pending={working && !reviewResp}
            disabled={!!reviewResp}
          />
          <button type="button" onClick={() => setSplitOpen(true)} disabled={working || !!reviewResp} className="btn-ghost rounded-lg px-4 py-2.5 mt-3 w-full text-sm disabled:opacity-40">
            Split money with two people
          </button>
        </div>
        <div className="glass rounded-2xl p-6">
          <div className="text-secondary text-sm font-medium uppercase tracking-wider mb-4">
            Pending requests
          </div>
          <PendingRequests
            items={requests}
            onPay={payRequest}
            onDecline={declineRequest}
            pendingId={working ? -1 : undefined}
          />
        </div>
      </motion.div>

      {/* Review card if active */}
      <AnimatePresence initial={false}>
        {reviewResp ? (
          <motion.div
            className="mb-4"
            initial={{ opacity: 0, height: 0, y: -8 }}
            animate={{ opacity: 1, height: "auto", y: 0 }}
            exit={{ opacity: 0, height: 0, y: -8 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            <ReviewCard
              resp={reviewResp}
              onConfirm={handleConfirm}
              onDecline={handleDecline}
              pending={working}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Chat bar (always on; lets users type or talk) */}
      <motion.div
        className="mb-4"
        variants={{ hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <ChatBar
          userId={activeId}
          onCommand={sendIntent}
          disabled={working}
          placeholder={
            reviewResp
              ? 'Tap a button on the card above to confirm or cancel'
              : "Send, request, split, pay bill, balance, or just chat…"
          }
        />
      </motion.div>

      <motion.div
        className="mb-4"
        variants={{ hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <SavingsGoals userId={activeId} />
      </motion.div>

      {/* Bottom row: history + chart */}
      <motion.div
        className="grid grid-cols-1 lg:grid-cols-3 gap-4"
        variants={{ hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        {/* Recent — fixed ceiling with internal scroll. The card grows up
            to a max height, then its body scrolls. Header stays pinned so
            the section title doesn't move. */}
        <div className="lg:col-span-2 glass rounded-2xl p-6 flex flex-col min-h-0 max-h-[480px]">
          <div className="text-secondary text-sm font-medium uppercase tracking-wider mb-4 shrink-0">
            Recent
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto -mr-2 pr-2">
            <HistoryList txns={history?.txns ?? []} />
          </div>
        </div>
        {/* Balance chart card — mirrors the same fixed ceiling so the
            history card and the chart card stay the same height as the
            activity list grows. */}
        <div className="glass rounded-2xl p-6 flex flex-col min-h-0 max-h-[480px]">
          <div className="text-secondary text-sm font-medium uppercase tracking-wider mb-4 shrink-0">
            Balance · 14 days
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto -mr-2 pr-2">
            <BalanceChart data={history?.timeline ?? []} />
          </div>
        </div>
      </motion.div>

      {/* Voice orb — always-on voice indicator (floating bottom-center) */}
      <VoiceOrb />

      {/* Face ID confirm overlay — gates the actual /agent/confirm call
          on a successful face match. Only opens when the user has an
          active enrollment; un-enrolled users fall through to the
          regular confirm path. */}
      <AnimatePresence>
        {faceConfirmOpen && activeId !== null ? (
          <FaceIDConfirm
            userId={activeId}
            onMatch={confirmAfterFaceID}
            onCancel={() => setFaceConfirmOpen(false)}
            onEnrollInstead={() => {
              setFaceConfirmOpen(false);
              setSettingsOpen(true);
            }}
          />
        ) : null}
      </AnimatePresence>

      {/* Toast */}
      {toast ? (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 glass-strong rounded-full px-5 py-3 text-sm text-cream max-w-md text-center shadow-glow-peach">
          {toast}
        </div>
      ) : null}

      {/* Settings modal */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        userId={activeId}
      />

      {/* Ask-for-money modal */}
      <AnimatePresence>
        {askOpen ? (
          <motion.div
            className="fixed inset-0 z-40 flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div
              className="absolute inset-0 bg-plum-950/60 backdrop-blur-sm"
              onClick={() => setAskOpen(false)}
            />
            <motion.div
              className="relative w-full max-w-md glass-strong rounded-2xl p-6"
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-cream">Ask for money</h2>
              <button
                type="button"
                onClick={() => setAskOpen(false)}
                className="text-cream/70 hover:text-cream text-xl leading-none"
              >
                ×
              </button>
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="block text-xs text-cream/70 mb-1">From</span>
                <select
                  value={askRecipient}
                  onChange={(e) => setAskRecipient(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-cream focus:outline-none focus:border-peach-500/50"
                >
                  <option value="">Pick someone…</option>
                  {recipientHandles.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs text-cream/70 mb-1">Amount (৳)</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={askAmount}
                  onChange={(e) => setAskAmount(e.target.value)}
                  placeholder="500"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-cream placeholder:text-secondary focus:outline-none focus:border-peach-500/50"
                />
              </label>
              <label className="block">
                <span className="block text-xs text-cream/70 mb-1">Note (optional)</span>
                <input
                  type="text"
                  value={askNote}
                  onChange={(e) => setAskNote(e.target.value)}
                  placeholder="chai, lunch, …"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-cream placeholder:text-secondary focus:outline-none focus:border-peach-500/50"
                />
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setAskOpen(false)}
                  className="btn-ghost rounded-full px-4 py-2 text-sm"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleAsk}
                  disabled={!askRecipient || !askAmount || working}
                  className="btn-peach rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-40"
                >
                  Send request
                </button>
              </div>
            </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {splitOpen ? (
          <motion.div className="fixed inset-0 z-40 flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-plum-950/60 backdrop-blur-sm" onClick={() => setSplitOpen(false)} />
            <motion.div className="relative w-full max-w-md glass-strong rounded-2xl p-6" initial={{ opacity: 0, scale: 0.96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 12 }}>
              <div className="flex items-center justify-between mb-4"><h2 className="text-lg font-bold text-cream">Split money</h2><button type="button" onClick={() => setSplitOpen(false)} className="text-cream/70 text-xl">×</button></div>
              <p className="text-sm text-secondary mb-4">Choose two people. The total is divided equally and confirmed once.</p>
              <SplitForm recipients={recipientHandles} onSubmit={handleSplit} disabled={working} />
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <footer className="pt-8 pb-2 text-center text-xs text-secondary">
        Developed by{" "}
        <a
          href="https://github.com/bikash-20"
          target="_blank"
          rel="noopener noreferrer"
          className="text-peach-500 hover:text-peach-300 transition-colors"
        >
          Bikash Talukder
        </a>
      </footer>
    </motion.div>
  );
}
