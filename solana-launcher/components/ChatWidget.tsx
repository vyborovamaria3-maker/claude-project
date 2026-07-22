"use client";

import { useState, useRef, useEffect } from "react";
import { MessageSquare, X, Send, Paperclip } from "lucide-react";

interface Message {
  id: string;
  type: "user" | "assistant" | "element";
  content: string;
  timestamp: Date;
}

// Global state to share selected elements between components
let globalSelectedElement: string | null = null;
let globalListeners: ((element: string) => void)[] = [];

export function notifyElementSelected(elementInfo: string) {
  globalSelectedElement = elementInfo;
  globalListeners.forEach(listener => listener(elementInfo));
}

export function subscribeToElementSelection(listener: (element: string) => void) {
  globalListeners.push(listener);
  return () => {
    globalListeners = globalListeners.filter(l => l !== listener);
  };
}

// data-tag: chat.widget
export default function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pendingElement, setPendingElement] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Subscribe to element selections from DevInspector
  useEffect(() => {
    const unsubscribe = subscribeToElementSelection((elementInfo) => {
      if (isOpen) {
        // If chat is open, add element as a message immediately
        const elementMsg: Message = {
          id: Date.now().toString(),
          type: "element",
          content: elementInfo,
          timestamp: new Date(),
        };
        setMessages(prev => [...prev, elementMsg]);
      } else {
        // If chat is closed, store as pending and open chat
        setPendingElement(elementInfo);
        setIsOpen(true);
      }
    });

    return unsubscribe;
  }, [isOpen]);

  // Add pending element when chat opens
  useEffect(() => {
    if (isOpen && pendingElement) {
      const elementMsg: Message = {
        id: Date.now().toString(),
        type: "element",
        content: pendingElement,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, elementMsg]);
      setPendingElement(null);
    }
  }, [isOpen, pendingElement]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when chat opens
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  const sendMessage = () => {
    if (!input.trim()) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      type: "user",
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMsg]);
    setInput("");

    // Simulate assistant response (placeholder for AI integration)
    setTimeout(() => {
      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        type: "assistant",
        content: "Принято. Работаю над этим...",
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, assistantMsg]);
    }, 500);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages([]);
  };

  return (
    <>
      {/* Floating Chat Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        data-tag="chat.toggle"
          className={[
          "fixed bottom-6 left-6 z-[9999] w-12 h-12 rounded-full flex items-center justify-center border-2 transition-all duration-200 shadow-lg",
          isOpen
            ? "bg-[color:var(--theme-primary)] text-[color:var(--theme-content-inverted)] border-[color-mix(in_srgb,var(--theme-primary)_45%,transparent)] rotate-0"
            : "bg-bg-card border-[color-mix(in_srgb,var(--theme-primary)_50%,transparent)] text-[color:var(--theme-primary)] hover:border-[color-mix(in_srgb,var(--theme-primary)_70%,transparent)]",
          pendingElement && !isOpen && "animate-pulse ring-2 ring-[color:var(--theme-primary)]",
        ].join(" ")}
        title={isOpen ? "Закрыть чат" : pendingElement ? "Новый элемент выбран!" : "Открыть чат"}
      >
        {isOpen ? <X className="w-5 h-5" /> : <MessageSquare className="w-5 h-5" />}
      </button>

      {/* Pending indicator */}
      {pendingElement && !isOpen && (
        <div className="fixed bottom-20 left-6 z-[9999] bg-[color:var(--theme-primary)] text-[color:var(--theme-content-inverted)] text-xs font-semibold px-3 py-1.5 rounded-full shadow-lg">
          Элемент выбран!
        </div>
      )}

      {/* Chat Panel */}
      {isOpen && (
        <div
          data-tag="chat.panel"
          className="fixed bottom-20 left-6 z-[9999] w-[380px] max-w-[calc(100vw-48px)] surface-panel rounded-2xl border border-bg-border shadow-2xl flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-bg-border bg-bg-card/60">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-[color:var(--theme-primary)]" />
              <span className="text-sm font-semibold text-white">AI Assistant</span>
              <span className="text-[10px] text-white/40 bg-white/10 px-2 py-0.5 rounded-full">Dev Mode</span>
            </div>
            <button
              onClick={clearChat}
              className="text-xs text-white/40 hover:text-white/70 transition"
            >
              Очистить
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 max-h-[400px] min-h-[200px] overflow-y-auto p-4 space-y-3">
            {messages.length === 0 ? (
              <div className="text-center py-8 text-white/40 text-sm">
                <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>Нажмите на любой блок с data-tag,</p>
                <p>чтобы автоматически вставить его сюда</p>
                <p className="mt-4 text-xs text-[color:var(--theme-primary)]/60">
                  Или напишите сообщение вручную
                </p>
              </div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={[
                    "rounded-xl px-3 py-2 text-sm",
                    msg.type === "user" && "bg-[color-mix(in_srgb,var(--theme-primary)_20%,transparent)] text-white ml-8 border border-[color-mix(in_srgb,var(--theme-primary)_30%,transparent)]",
                    msg.type === "assistant" && "bg-bg-card/60 text-white/80 mr-8 border border-bg-border",
                    msg.type === "element" && "bg-[color-mix(in_srgb,var(--theme-warning)_10%,transparent)] text-[color:var(--theme-warning)] border border-[color-mix(in_srgb,var(--theme-warning)_30%,transparent)] font-mono text-xs",
                  ].join(" ")}
                >
                  {msg.type === "element" && (
                    <div className="flex items-center gap-1.5 mb-1 text-[10px] uppercase tracking-wider text-[color:var(--theme-warning)]/70">
                      <Paperclip className="w-3 h-3" />
                      Выбранный элемент
                    </div>
                  )}
                  <div className="break-words">{msg.content}</div>
                  <div className="text-[10px] text-white/30 mt-1 text-right">
                    {msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-bg-border p-3 bg-bg-card/40">
            <div className="flex gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Напишите сообщение..."
                className="flex-1 bg-bg-soft/60 border border-bg-border rounded-xl px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-[color-mix(in_srgb,var(--theme-primary)_50%,transparent)] resize-none min-h-[40px] max-h-[100px]"
                rows={1}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim()}
                className="px-3 py-2 bg-[color:var(--theme-primary)] text-[color:var(--theme-content-inverted)] rounded-xl hover:brightness-110 transition disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            <div className="flex justify-between mt-2">
              <p className="text-[10px] text-white/30">
                Shift+Enter для новой строки
              </p>
              <p className="text-[10px] text-white/30">
                {messages.filter(m => m.type === "element").length} элементов
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
