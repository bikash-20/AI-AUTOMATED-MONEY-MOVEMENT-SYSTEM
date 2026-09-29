"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Scan, ShieldCheck, Trash2 } from "lucide-react";
import { api, FaceStatus } from "@/lib/api";
import { readStoredEmbedding, clearStoredEmbedding } from "@/lib/face-storage";

// Face ID is camera-heavy and uses tfjs/onnxruntime — only ever run in
// the browser. Dynamic-import keeps the bundle small and SSR-safe.
const FaceIDEnroll = dynamic(
  () =>
    import("@/components/FaceIDEnroll").then((m) => m.FaceIDEnroll),
  { ssr: false }
);

type Settings = {
  ollama_url: string;
  llm_cascade: string[];
  openrouter_url: string;
  openrouter_models: string[];
  openrouter_key_set: boolean;
  tts_engine: string;
  edge_tts_voice: string;
  qwen_tts_voice: string;
  stt_model: string;
  pending_ttl_seconds: number;
};

type Health = {
  ok: boolean;
  ollama_reachable: boolean;
  ollama_url: string;
  openrouter_reachable: boolean;
  openrouter_configured: boolean;
  regex_fallback: boolean;
};

export function SettingsModal({
  open,
  onClose,
  userId,
}: {
  open: boolean;
  onClose: () => void;
  userId: number | null;
}) {
  const [s, setS] = useState<Settings | null>(null);
  const [h, setH] = useState<Health | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [faceStatus, setFaceStatus] = useState<FaceStatus | null>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);

  // Local form state — only commit on Save.
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [cascade, setCascade] = useState("");
  const [orUrl, setOrUrl] = useState("");
  const [orModels, setOrModels] = useState("");
  const [orKey, setOrKey] = useState("");
  const [ttsEngine, setTtsEngine] = useState("qwen");
  const [edgeVoice, setEdgeVoice] = useState("");
  const [qwenVoice, setQwenVoice] = useState("");
  const [sttModel, setSttModel] = useState("base");

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setOk(null);
    const facePromise = userId !== null
      ? api.getFaceStatus(userId).catch(() => null)
      : Promise.resolve(null);
    Promise.all([api.getSettings(), api.getHealth(), facePromise])
      .then(([settings, health, face]) => {
        const st = settings as Settings;
        setS(st);
        setH(health);
        setFaceStatus(face);
        setOllamaUrl(st.ollama_url);
        setCascade((st.llm_cascade || []).join(", "));
        setOrUrl(st.openrouter_url);
        setOrModels((st.openrouter_models || []).join(", "));
        setOrKey(""); // never echo the existing key
        setTtsEngine(st.tts_engine);
        setEdgeVoice(st.edge_tts_voice);
        setQwenVoice(st.qwen_tts_voice);
        setSttModel(st.stt_model);
      })
      .catch((e) => setErr(`Load failed: ${(e as Error).message}`));
  }, [open, userId]);

  async function save() {
    setSaving(true);
    setErr(null);
    setOk(null);
    try {
      const patch: Record<string, unknown> = {
        ollama_url: ollamaUrl,
        llm_cascade: cascade,
        openrouter_url: orUrl,
        openrouter_models: orModels,
        tts_engine: ttsEngine,
        edge_tts_voice: edgeVoice,
        qwen_tts_voice: qwenVoice,
        stt_model: sttModel,
      };
      if (orKey.trim()) patch["openrouter_api_key"] = orKey.trim();
      const next = await api.patchSettings(patch);
      setS(next as Settings);
      const health = await api.getHealth();
      setH(health);
      setOk("Saved.");
    } catch (e) {
      setErr(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-plum-950/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-2xl glass-strong rounded-2xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-cream">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-cream/70 hover:text-cream text-xl leading-none"
            title="Close"
          >
            ×
          </button>
        </div>

        {/* Health bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-5 text-xs">
          <Status
            label="Ollama"
            on={h?.ollama_reachable ?? false}
            hint={h?.ollama_url ?? ""}
          />
          <Status
            label="OpenRouter"
            on={h?.openrouter_reachable ?? false}
            hint={
              h?.openrouter_configured
                ? "configured"
                : "no key set"
            }
          />
          <Status label="Regex fallback" on={h?.regex_fallback ?? false} hint="always on" />
          <Status
            label="Demo"
            on={h?.ok ?? false}
            hint="backend ok"
          />
        </div>

        {err ? (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-200 text-xs px-3 py-2 mb-3">
            {err}
          </div>
        ) : null}
        {ok ? (
          <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 text-xs px-3 py-2 mb-3">
            {ok}
          </div>
        ) : null}

        {/* Form */}
        <div className="space-y-4">
          <Section title="LLM endpoints">
            <Field
              label="Ollama URL"
              value={ollamaUrl}
              onChange={setOllamaUrl}
              placeholder="http://localhost:11434"
            />
            <Field
              label="Local cascade (comma)"
              value={cascade}
              onChange={setCascade}
              placeholder="qwen3:8b, deepseek-coder-v2:16b"
            />
            <Field
              label="OpenRouter URL"
              value={orUrl}
              onChange={setOrUrl}
              placeholder="https://openrouter.ai/api/v1"
            />
            <Field
              label="OpenRouter models (comma)"
              value={orModels}
              onChange={setOrModels}
              placeholder="qwen/qwen-2.5-7b-instruct:free, deepseek/deepseek-chat-v3-0324:free"
            />
            <Field
              label="OpenRouter API key"
              value={orKey}
              onChange={setOrKey}
              placeholder={
                s?.openrouter_key_set ? "(key set — leave blank to keep)" : "sk-or-…"
              }
              type="password"
            />
            <p className="text-[11px] text-secondary">
              When the local cascade returns empty, the backend tries OpenRouter
              keys. Without a key, the regex fallback keeps the demo alive.
            </p>
          </Section>

          <Section title="Voice">
            <Select
              label="TTS engine"
              value={ttsEngine}
              onChange={setTtsEngine}
              options={["qwen", "edge"]}
            />
            <Field
              label="Edge TTS voice"
              value={edgeVoice}
              onChange={setEdgeVoice}
              placeholder="en-US-GuyNeural"
            />
            <Field
              label="Qwen3 TTS voice"
              value={qwenVoice}
              onChange={setQwenVoice}
              placeholder="Ryan"
            />
            <Field
              label="Whisper model"
              value={sttModel}
              onChange={setSttModel}
              placeholder="base | small | medium"
            />
          </Section>

          <Section title="Face ID">
            {userId === null ? (
              <p className="text-xs text-secondary">
                Sign in to a user before enrolling Face ID.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between rounded-lg bg-white/5 border border-white/10 px-3 py-2">
                  <div className="flex items-center gap-2">
                    {faceStatus?.enrolled ? (
                      <ShieldCheck
                        size={16}
                        strokeWidth={1.8}
                        className="text-mint-400"
                      />
                    ) : (
                      <Scan
                        size={16}
                        strokeWidth={1.8}
                        className="text-secondary"
                      />
                    )}
                    <div>
                      <div className="text-sm text-cream">
                        {faceStatus?.enrolled
                          ? "Face ID enrolled"
                          : "Face ID not enrolled"}
                      </div>
                      <div className="text-[11px] text-secondary">
                        {faceStatus?.enrolled
                          ? `Enrolled ${
                              faceStatus.enrolled_at
                                ? new Date(faceStatus.enrolled_at).toLocaleString()
                                : ""
                            }`
                          : "Used to confirm payments instead of typing."}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setEnrollOpen(true)}
                      className="btn-peach rounded-full px-3 py-1.5 text-xs font-semibold"
                    >
                      {faceStatus?.enrolled ? "Re-enroll" : "Enroll"}
                    </button>
                    {faceStatus?.enrolled ? (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api.deleteFace(userId);
                            clearStoredEmbedding(userId);
                            setFaceStatus({
                              user_id: userId,
                              enrolled: false,
                              enrolled_at: null,
                            });
                          } catch (e) {
                            setErr(
                              `Remove failed: ${(e as Error).message}`
                            );
                          }
                        }}
                        className="btn-ghost rounded-full px-3 py-1.5 text-xs flex items-center gap-1"
                        title="Remove Face ID enrollment"
                      >
                        <Trash2 size={12} strokeWidth={1.8} />
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
                {enrollOpen ? (
                  <FaceIDEnroll
                    userId={userId}
                    initialEnrolled={faceStatus?.enrolled ?? false}
                    onClose={() => setEnrollOpen(false)}
                    onEnrolled={() => {
                      setEnrollOpen(false);
                      // Refresh status so the section header updates.
                      api
                        .getFaceStatus(userId)
                        .then(setFaceStatus)
                        .catch(() => {});
                    }}
                    onDeleted={() => {
                      setEnrollOpen(false);
                      setFaceStatus({
                        user_id: userId,
                        enrolled: false,
                        enrolled_at: null,
                      });
                    }}
                  />
                ) : null}
                <p className="text-[11px] text-secondary">
                  Matching runs entirely in your browser; only a 128-dim
                  number array is stored on the server. Demo-only — not a
                  security boundary.
                </p>
              </>
            )}
          </Section>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn-ghost rounded-full px-4 py-2 text-sm"
            >
              Close
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="btn-peach rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-secondary text-xs uppercase tracking-wider mb-2">
        {title}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-cream/70 mb-1">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-cream placeholder:text-secondary focus:outline-none focus:border-peach-500/50"
      />
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="block">
      <span className="block text-xs text-cream/70 mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-cream focus:outline-none focus:border-peach-500/50"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Status({
  label,
  on,
  hint,
}: {
  label: string;
  on: boolean;
  hint: string;
}) {
  return (
    <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-2">
      <div className="flex items-center gap-2">
        <span
          className={
            "w-2 h-2 rounded-full " +
            (on ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" : "bg-red-400")
          }
        />
        <span className="text-cream font-medium">{label}</span>
      </div>
      <div className="text-[10px] text-secondary mt-0.5 truncate" title={hint}>
        {hint}
      </div>
    </div>
  );
}
