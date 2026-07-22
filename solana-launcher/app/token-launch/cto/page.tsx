"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Stepper, TOTAL_STEPS } from "./Stepper";
import CTOStep1 from "./CTOStep1";
import TLstep_2 from "@/app/token-launch/new/TLstep_2";
import TLstep_3 from "@/app/token-launch/new/TLstep_3";
import TLstep_4 from "@/app/token-launch/new/TLstep_4";
import TLstep_5 from "@/app/token-launch/new/TLstep_5";
import type { TokenMeta } from "./types";

const STEP_LABELS: Record<number, string> = {
  1: "Token",
  2: "Buy Mode",
  3: "Wallets",
  4: "Review",
  5: "Launch",
};

const LS_STEP_KEY = "cto_step";
const LS_META_KEY = "cto_meta";
const LS_MINT_KEY = "cto_mint";
const LS_FORM_KEY = "cto_form";

function readLS<T>(key: string, fallback: T): T {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; } catch { return fallback; }
}

// data-tag: page.token_launch.cto
export default function CTOPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [meta, setMeta] = useState<TokenMeta | null>(null);
  const [mint, setMint] = useState("");
  const [formData, setFormData] = useState<Record<string, any>>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setStep(readLS(LS_STEP_KEY, 1));
    setMeta(readLS(LS_META_KEY, null));
    setMint(readLS(LS_MINT_KEY, ""));
    setFormData(readLS(LS_FORM_KEY, {}));
    setHydrated(true);
  }, []);

  useEffect(() => { if (hydrated) localStorage.setItem(LS_STEP_KEY, JSON.stringify(step)); }, [step, hydrated]);
  useEffect(() => { if (hydrated) localStorage.setItem(LS_META_KEY, JSON.stringify(meta)); }, [meta, hydrated]);
  useEffect(() => { if (hydrated) localStorage.setItem(LS_MINT_KEY, JSON.stringify(mint)); }, [mint, hydrated]);
  useEffect(() => { if (hydrated) localStorage.setItem(LS_FORM_KEY, JSON.stringify(formData)); }, [formData, hydrated]);

  const next = () => setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  const prev = () => setStep((s) => Math.max(s - 1, 1));
  const update = (patch: Record<string, any>) => setFormData((f) => ({ ...f, ...patch }));

  const stepProps = { data: formData, update, next, prev };

  if (!hydrated) return null;

  return (
    <div data-tag="page.token_launch.cto">
      <div className="flex items-start gap-3 mb-8">
        <button
          type="button"
          onClick={() => (step === 1 ? router.push("/token-launch") : prev())}
          className="mt-1 text-white/60 hover:text-white transition"
          aria-label="Back"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-white">CTO</h1>
          <p className="text-base text-white/50 mt-1">
            Step {step} of {TOTAL_STEPS} - {STEP_LABELS[step]}
          </p>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 pb-12">
        <Stepper current={step} />

        {step === 1 && (
          <CTOStep1
            onContinue={(m, addr) => { setMeta(m); setMint(addr); next(); }}
          />
        )}
        {step === 2 && <TLstep_2 {...stepProps} />}
        {step === 3 && <TLstep_3 {...stepProps} />}
        {step === 4 && <TLstep_4 {...stepProps} />}
        {step === 5 && <TLstep_5 {...stepProps} />}
      </div>
    </div>
  );
}
