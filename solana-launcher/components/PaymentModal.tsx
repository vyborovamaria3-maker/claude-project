"use client";

import { useState } from "react";
import { X, Info, ExternalLink } from "lucide-react";

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onBuyAccess: () => void;
  onShowInfo: () => void;
  price: string;
}

export default function PaymentModal({ isOpen, onClose, onBuyAccess, onShowInfo, price }: PaymentModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-black/80 p-6 shadow-2xl">
        <button onClick={onClose} className="absolute right-4 top-4 text-white/60 hover:text-white">
          <X className="h-5 w-5" />
        </button>
        
        <h2 className="text-2xl font-bold text-white">Получите доступ</h2>
        <p className="mt-2 text-white/60">Полный доступ к функционалу на 30 дней</p>
        
        <div className="mt-6 rounded-xl border border-neon-green/30 bg-neon-green/10 p-4">
          <div className="text-3xl font-black text-neon-green">{price}</div>
          <div className="text-sm text-white/60">разовый платёж</div>
        </div>
        
        <div className="mt-6 space-y-3">
          <button
            onClick={onBuyAccess}
            className="w-full rounded-xl bg-neon-green px-4 py-3 font-semibold text-white transition hover:scale-[1.02]"
          >
            Купить доступ
          </button>
          <button
            onClick={onShowInfo}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 font-semibold text-white transition hover:bg-white/10"
          >
            <Info className="h-4 w-4" />
            Что это за софт?
          </button>
        </div>
      </div>
    </div>
  );
}
