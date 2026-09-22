let activeUtterance: SpeechSynthesisUtterance | null = null;

export function speakText(text: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const clean = text.replace(/[`*_]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return;

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = "en-US";
  utterance.rate = 0.96;
  utterance.pitch = 1.02;
  utterance.volume = 1;
  activeUtterance = utterance;
  utterance.onend = () => {
    if (activeUtterance === utterance) activeUtterance = null;
  };
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  activeUtterance = null;
}
