// Approval window (approve.html#<id>) for a site's request; closing it refuses.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import WalletApprove from "../design/WalletApprove";
import { bg } from "./bg";
import type { ApprovalView } from "../provider/server";
import "./base.css";

// Clickjacking guard, kept outside the generated design: a click counts only once the window has been visible
// and focused for SEEN_MS and the pointer moved in it (or a key is pressed).
const SEEN_MS = 800;
let readyAt = Date.now() + SEEN_MS;
let moved = false;
const startOver = () => {
  readyAt = Date.now() + SEEN_MS;
  moved = false;
};
const armed = () => document.visibilityState === "visible" && document.hasFocus() && Date.now() >= readyAt && moved;
window.addEventListener("blur", startOver);
window.addEventListener("focus", startOver);
document.addEventListener("visibilitychange", startOver);
window.addEventListener("pointermove", () => void (moved = true), true);
window.addEventListener("keydown", () => void (Date.now() >= readyAt && (moved = true)), true);
// Early clicks are swallowed in the capture phase, except Reject, Cancel and Close.
window.addEventListener(
  "click",
  (e) => {
    if (armed()) return;
    const button = (e.target as Element | null)?.closest?.("button");
    if (button && /^(Reject|Cancel|Close)$/.test((button.textContent ?? "").trim())) return;
    e.stopPropagation();
    e.preventDefault();
  },
  true,
);

function Approve() {
  const id = location.hash.slice(1);
  const [view, setView] = useState<ApprovalView | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    bg<ApprovalView | null>({ type: "approval", id }).then(setView, () => setView(null));
  }, [id]);

  useEffect(() => {
    if (view === null) window.close(); // answered elsewhere, or gone
  }, [view]);

  if (!view) return null;

  const answer = async (approve: boolean, p?: { addressChoice?: "main" | "fresh"; riskAccepted?: boolean }) => {
    if (approve && !armed()) return;
    setBusy(true);
    await bg({ type: "approvalDecision", id, approve, addressChoice: p?.addressChoice ?? view.addressChoice, riskAccepted: p?.riskAccepted }).catch(() => undefined);
    window.close();
  };

  return (
    <WalletApprove
      {...view}
      state={busy ? "approving" : view.state}
      onApprove={(p: { addressChoice?: "main" | "fresh"; riskAccepted?: boolean }) => void answer(true, p)}
      onReject={() => void answer(false)}
      onCancel={() => void answer(false)}
      onClose={() => void answer(false)}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Approve />);
