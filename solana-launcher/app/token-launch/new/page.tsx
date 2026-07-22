"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import TLstep_1 from "./TLstep_1";
import TLstep_2 from "./TLstep_2";
import TLstep_3 from "./TLstep_3";
import TLstep_4 from "./TLstep_4";
import TLstep_5 from "./TLstep_5";

const STEP_TITLES = ["Metadata", "Buy Mode", "Wallets", "Review", "Launch"];
const TOTAL_STEPS = 5;
const LS_STEP_KEY = "new_bundle_step";
const LS_DATA_KEY = "new_bundle_form";

function readLS<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

// data-tag: page.token_launch.new
export default function NewBundlePage() {
  const [step, setStep] = useState<number>(1);
  const [formData, setFormData] = useState<Record<string, any>>({});
  const [hydrated, setHydrated] = useState(false);

  // Restore from localStorage after mount (avoids SSR mismatch)
  useEffect(() => {
    setStep(readLS(LS_STEP_KEY, 1));
    setFormData(readLS(LS_DATA_KEY, {}));
    setHydrated(true);
  }, []);

  // Persist on every change, but only after hydration
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(LS_STEP_KEY, JSON.stringify(step));
  }, [step, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(LS_DATA_KEY, JSON.stringify(formData));
  }, [formData, hydrated]);

  const router = useRouter();

  const next = () => setStep((s) => Math.min(TOTAL_STEPS, s + 1));
  const prev = () => setStep((s) => Math.max(1, s - 1));

  const handleBack = () => {
    if (step === 1) {
      router.push("/token-launch");
    } else {
      prev();
    }
  };
  const update = (patch: Record<string, any>) =>
    setFormData((prev) => ({ ...prev, ...patch }));

  const stepProps = { data: formData, update, next, prev };

  return (
    <div data-tag="page.token_launch.new" className="w-full min-w-0">
      {/* Header — pinned top-left */}
      <div data-tag="token_launch.new.header" className="flex items-start gap-3 mb-8">
        <button
          type="button"
          data-tag="token_launch.new.back"
          onClick={handleBack}
          className="mt-1 text-white/60 hover:text-white transition"
          aria-label="Back"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white">New Bundle</h1>
          <p className="text-sm text-white/50 mt-1">
            Step {step} of {TOTAL_STEPS} - {STEP_TITLES[step - 1]}
          </p>
        </div>
      </div>

      <div className="w-full min-w-0 max-w-4xl mx-auto px-0 sm:px-4 pb-8">
        {/* Stepper */}
        <Stepper current={step} total={TOTAL_STEPS} />

        {/* Step body */}
        <div className="mt-8">
          {step === 1 && <TLstep_1 {...stepProps} />}
          {step === 2 && <TLstep_2 {...stepProps} />}
          {step === 3 && <TLstep_3 {...stepProps} />}
          {step === 4 && <TLstep_4 {...stepProps} />}
          {step === 5 && <TLstep_5 {...stepProps} />}
        </div>
      </div>
    </div>
  );
}

function Stepper({ current, total }: { current: number; total: number }) {
  return (
    <div data-tag="token_launch.new.stepper" className="flex items-center justify-center gap-2 md:gap-3">
      {Array.from({ length: total }).map((_, i) => {
        const n = i + 1;
        const active = n === current;
        const done = n < current;
        return (
          <div key={n} className="flex items-center gap-2 md:gap-3">
            <div
              className={[
                "w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold border transition",
                active
                  ? "bg-neon-green/20 border-neon-green text-neon-green shadow-neon-green"
                  : done
                  ? "bg-neon-green/10 border-neon-green/50 text-neon-green"
                  : "bg-bg-soft border-bg-border text-white/40",
              ].join(" ")}
            >
              {n}
            </div>
            {n < total && (
              <div
                className={[
                  "w-8 md:w-12 h-px",
                  done ? "bg-neon-green/50" : "bg-bg-border",
                ].join(" ")}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
