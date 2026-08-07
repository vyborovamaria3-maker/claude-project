export default function SocialAnalysisLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 animate-pulse rounded-xl bg-bg-elevated" />
        <div className="space-y-2">
          <div className="h-4 w-48 animate-pulse rounded bg-bg-elevated" />
          <div className="h-3 w-72 max-w-[70vw] animate-pulse rounded bg-bg-elevated" />
        </div>
      </div>
      <div className="h-11 animate-pulse rounded-xl border border-bg-border bg-bg-card" />
      <div className="surface-panel rounded-2xl border border-bg-border p-5">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="h-24 animate-pulse rounded-xl bg-bg-elevated/60" />
          ))}
        </div>
      </div>
    </div>
  );
}
