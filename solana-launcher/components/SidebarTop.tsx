"use client";

// data-tag: brand.logo (grid row 1 col 1)
// Brand name "POTAPoff" is a proper brand name and should remain hardcoded
export default function SidebarTop() {
  return (
    <div
      data-tag="brand.logo"
      className="border-r border-b border-bg-border bg-bg/80 backdrop-blur-xl flex items-center gap-3 px-5 h-[72px] flex-nowrap"
    >
      <div className="w-10 h-10 shrink-0 overflow-hidden rounded-xl border border-primary-border bg-black shadow-neon-green">
        <img
          src="/brand/logo.webp"
          alt=""
          aria-hidden="true"
          className="h-full w-full object-contain"
        />
      </div>
      <span className="neon-text-green font-black tracking-widest text-xl uppercase leading-none">POTAPoff</span>
    </div>
  );
}
