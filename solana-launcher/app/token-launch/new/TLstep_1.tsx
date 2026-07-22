"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { StepProps } from "./types";

type Platform = "pump.fun";
type Mode = "classic" | "mayhem";

// data-tag: token_launch.new.step1
export default function TLstep_1({ data, update, next }: StepProps) {
  const [name, setName] = useState<string>(data.name ?? "");
  const [symbol, setSymbol] = useState<string>(data.symbol ?? "");
  const [description, setDescription] = useState<string>(data.description ?? "");
  const [website, setWebsite] = useState<string>(data.website ?? "");
  const [xUrl, setXUrl] = useState<string>(data.xUrl ?? "");
  const [telegram, setTelegram] = useState<string>(data.telegram ?? "");
  const [platform, setPlatform] = useState<Platform>(data.platform ?? "pump.fun");
  const [mode, setMode] = useState<Mode>(data.mode ?? "classic");
  const [imageName, setImageName] = useState<string>(data.imageName ?? "");
  const fileRef = useRef<HTMLInputElement>(null);

  const isValid = !!(name.trim() && symbol.trim());

  const save = (patch: Record<string, any>) => update(patch);

  const handleName = (v: string) => { setName(v); save({ name: v }); };
  const handleSymbol = (v: string) => { setSymbol(v); save({ symbol: v.toUpperCase() }); };
  const handleDescription = (v: string) => { setDescription(v); save({ description: v }); };
  const handleWebsite = (v: string) => { setWebsite(v); save({ website: v }); };
  const handleXUrl = (v: string) => { setXUrl(v); save({ xUrl: v }); };
  const handleTelegram = (v: string) => { setTelegram(v); save({ telegram: v }); };
  const handlePlatform = (v: Platform) => { setPlatform(v); save({ platform: v }); };
  const handleMode = (v: Mode) => { setMode(v); save({ mode: v }); };

  const handleContinue = () => {
    if (!isValid) return;
    next();
  };

  const onPickFile = (f?: File | null) => {
    if (f) { setImageName(f.name); save({ imageName: f.name }); }
  };

  return (
    <div data-tag="token_launch.new.step1" className="glass p-6 md:p-8 space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Field
          tag="step1.field.name"
          label="Name"
          required
          placeholder="My Token"
          value={name}
          onChange={handleName}
        />
        <Field
          tag="step1.field.symbol"
          label="Symbol"
          required
          placeholder="MTK"
          value={symbol}
          onChange={handleSymbol}
        />
      </div>

      <div data-tag="step1.field.description">
        <Label>Description <Optional /></Label>
        <textarea
          rows={3}
          value={description}
          onChange={(e) => handleDescription(e.target.value)}
          placeholder="Describe your token..."
          className="mt-1 w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-neon-green/50"
        />
      </div>

      <div data-tag="step1.field.image">
        <Label>Select Image <Optional /></Label>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="mt-1 w-full border-2 border-dashed border-bg-border rounded-lg p-8 flex flex-col items-center justify-center text-white/40 hover:border-neon-green/40 transition"
        >
          <Upload className="w-6 h-6 mb-2" />
          <span className="text-sm">
            {imageName ? imageName : "Click or drag to upload"}
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => onPickFile(e.target.files?.[0])}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <Field
          tag="step1.field.website"
          label="Website"
          optional
          placeholder="https://"
          value={website}
          onChange={handleWebsite}
        />
        <Field
          tag="step1.field.x_url"
          label="X URL"
          optional
          placeholder="https://x.com/..."
          value={xUrl}
          onChange={handleXUrl}
        />
        <Field
          tag="step1.field.telegram"
          label="Telegram"
          optional
          placeholder="https://t.me/..."
          value={telegram}
          onChange={handleTelegram}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div data-tag="step1.field.platform">
          <Label>Platform</Label>
          <div className="mt-1 grid grid-cols-1">
            <SegmentButton
              active={platform === "pump.fun"}
              onClick={() => handlePlatform("pump.fun")}
            >
              <span className="mr-2">💊</span> Pump.fun
            </SegmentButton>
          </div>
        </div>
        <div data-tag="step1.field.mode">
          <Label>Mode</Label>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <SegmentButton active={mode === "classic"} onClick={() => handleMode("classic")}>
              Classic
            </SegmentButton>
            <SegmentButton active={mode === "mayhem"} onClick={() => handleMode("mayhem")}>
              Mayhem
            </SegmentButton>
          </div>
        </div>
      </div>

      <div className="flex justify-center pt-2">
        <button
          type="button"
          data-tag="step1.continue"
          disabled={!isValid}
          onClick={handleContinue}
          className="px-10 py-2.5 rounded-lg bg-neon-green text-bg font-semibold hover:shadow-neon-green disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="text-sm font-medium text-white/80">{children}</label>;
}

function Optional() {
  return <span className="ml-1 text-xs text-white/40">(optional)</span>;
}

function Field({
  tag,
  label,
  placeholder,
  value,
  onChange,
  required,
  optional,
}: {
  tag: string;
  label: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  optional?: boolean;
}) {
  return (
    <div data-tag={tag}>
      <Label>
        {label}
        {required && <span className="ml-1 text-neon-red">*</span>}
        {optional && <Optional />}
      </Label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-neon-green/50"
      />
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "py-2 rounded-lg text-sm font-medium border transition",
        active
          ? "bg-neon-green/20 border-neon-green text-neon-green shadow-neon-green"
          : "bg-bg-soft/60 border-bg-border text-white/70 hover:border-white/20",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
