"use client";

// data-tag: brand.logo (grid row 1 col 1)
// Brand name "POTAPoff" is a proper brand name and should remain hardcoded
export default function SidebarTop() {
  return (
    <div
      data-tag="brand.logo"
      className="border-r border-b border-bg-border bg-bg/80 backdrop-blur-xl flex items-center gap-3 px-5 h-[72px] flex-nowrap"
    >
      <div className="w-10 h-10 shrink-0 rounded-xl bg-primary-soft border border-primary-border flex items-center justify-center shadow-neon-green">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
          <polygon points="11,2 14,9 21,9 15.5,13.5 17.5,21 11,16.5 4.5,21 6.5,13.5 1,9 8,9" fill="none" stroke="var(--theme-primary)" strokeWidth="1.5" strokeLinejoin="round"/>
          <circle cx="11" cy="11" r="3" fill="var(--theme-primary)" opacity="0.85"/>
          <line x1="11" y1="2" x2="11" y2="5" stroke="var(--theme-primary)" strokeWidth="1.5" strokeLinecap="round"/>
          <line x1="21" y1="9" x2="18" y2="9.8" stroke="var(--theme-primary)" strokeWidth="1.5" strokeLinecap="round"/>
          <line x1="17.5" y1="21" x2="15.5" y2="18.5" stroke="var(--theme-primary)" strokeWidth="1.5" strokeLinecap="round"/>
          <line x1="4.5" y1="21" x2="6.5" y2="18.5" stroke="var(--theme-primary)" strokeWidth="1.5" strokeLinecap="round"/>
          <line x1="1" y1="9" x2="4" y2="9.8" stroke="var(--theme-primary)" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </div>
      <span className="neon-text-green font-black tracking-widest text-xl uppercase leading-none">POTAPoff</span>
    </div>
  );
}
