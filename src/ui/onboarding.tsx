// Onboarding tab: create or import a wallet. Opened as #restore (forgot password), an import replaces the saved one.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import WalletOnboarding from "../design/WalletOnboarding";
import { bg, BgError } from "./bg";
import { isPhrase, parseSecretKey, WORDLIST } from "../lib/keys";
import type { WalletState } from "../lib/protocol";
import "./base.css";

type Step = "welcome" | "backup" | "confirm" | "password" | "import" | "done";
type Pending = { type: "phrase"; phrase: string } | { type: "key"; key: string };
type Imported = { type: "phrase"; words: string[] } | { type: "key"; key: string };

const RESTORE_NOTE = "Importing replaces the wallet saved in this browser.";

const randomIndex = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n;

function questionsFor(words: string[]) {
  const positions = words.length === 24 ? [3, 11, 19] : [3, 7, 11];
  return positions.map((n) => {
    const right = words[n - 1];
    const others = new Set<string>();
    while (others.size < 3) {
      const w = WORDLIST[randomIndex(WORDLIST.length)];
      if (!words.includes(w)) others.add(w);
    }
    const choices = [right, ...others];
    for (let i = choices.length - 1; i > 0; i--) {
      const j = randomIndex(i + 1);
      [choices[i], choices[j]] = [choices[j], choices[i]];
    }
    return { n, choices };
  });
}

function Onboarding() {
  const restore = location.hash === "#restore";
  const [step, setStep] = useState<Step>(restore ? "import" : "welcome");
  const [mode, setMode] = useState<"phrase" | "key">("phrase");
  const [words, setWords] = useState<string[]>([]);
  const [questions, setQuestions] = useState<{ n: number; choices: string[] }[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(restore ? RESTORE_NOTE : null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (restore) return;
    bg<WalletState>({ type: "state" }).then(
      (s) => s.hasVault && setStep("done"),
      () => undefined,
    );
  }, [restore]);

  const to = (s: Step) => {
    setError(s === "import" && restore ? RESTORE_NOTE : null);
    setStep(s);
  };

  return (
    <WalletOnboarding
      step={step}
      importMode={mode}
      error={error}
      words={words}
      questions={questions}
      onCreate={async () => {
        const phrase = await bg<string>({ type: "newPhrase" });
        const w = phrase.split(" ");
        setWords(w);
        setQuestions(questionsFor(w));
        to("backup");
      }}
      onHaveWallet={() => to("import")}
      onBackupDone={() => to("confirm")}
      onConfirm={(picks: Record<number, string>) => {
        if (!questions.every((q) => picks[q.n] === words[q.n - 1])) {
          setError("Those words don't match your recovery phrase. Check it and try again.");
          return;
        }
        setPending({ type: "phrase", phrase: words.join(" ") });
        to("password");
      }}
      onImportModeChange={(m: "phrase" | "key") => {
        setMode(m);
        setError(restore ? RESTORE_NOTE : null);
      }}
      onImport={(v: Imported) => {
        if (v.type === "phrase") {
          const phrase = v.words.join(" ");
          if (!isPhrase(phrase)) {
            setError("That recovery phrase isn't valid.");
            return;
          }
          setPending({ type: "phrase", phrase });
        } else {
          try {
            parseSecretKey(v.key).fill(0);
          } catch (e) {
            setError((e as Error).message);
            return;
          }
          setPending({ type: "key", key: v.key });
        }
        to("password");
      }}
      onSetPassword={async (password: string) => {
        if (!pending || busy) return;
        setBusy(true);
        try {
          if (pending.type === "phrase") await bg({ type: "create", phrase: pending.phrase, password, replace: restore });
          else await bg({ type: "importKey", key: pending.key, password, replace: restore });
          setPending(null);
          setWords([]);
          to("done");
        } catch (e) {
          setError(e instanceof BgError ? e.message : "Something went wrong. Try again.");
        } finally {
          setBusy(false);
        }
      }}
      onBack={(from: Step) => {
        const back: Record<Step, Step> = {
          welcome: "welcome",
          backup: "welcome",
          confirm: "backup",
          password: words.length ? "confirm" : "import",
          import: "welcome",
          done: "done",
        };
        to(back[from] ?? "welcome");
      }}
      onOpen={() => {
        const action = chrome.action as unknown as { openPopup?: () => Promise<void> };
        void action.openPopup?.().catch(() => undefined);
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Onboarding />);
