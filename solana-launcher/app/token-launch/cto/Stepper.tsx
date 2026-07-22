export const TOTAL_STEPS = 5;

export function Stepper({ current }: { current: number }) {
  return (
    <div className="flex items-center justify-center gap-3 md:gap-5 mb-10">
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => {
        const n = i + 1;
        const active = n === current;
        const done = n < current;
        return (
          <div key={n} className="flex items-center gap-2 md:gap-3">
            <div
              className={[
                "w-11 h-11 rounded-full flex items-center justify-center text-sm font-semibold border transition",
                active
                  ? "bg-neon-green/20 border-neon-green text-neon-green"
                  : done
                  ? "bg-neon-green/10 border-neon-green/50 text-neon-green"
                  : "bg-bg-soft border-bg-border text-white/40",
              ].join(" ")}
            >
              {n}
            </div>
            {n < TOTAL_STEPS && (
              <div
                className={["w-10 md:w-16 h-px", done ? "bg-neon-green/50" : "bg-bg-border"].join(" ")}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
