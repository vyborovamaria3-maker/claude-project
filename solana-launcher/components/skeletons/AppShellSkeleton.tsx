import { Skeleton } from "@/components/ui/skeleton";

export default function AppShellSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="rounded-2xl border border-bg-border bg-bg-card p-5 shadow-surface-soft">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-3">
            <Skeleton className="h-6 w-44 bg-white/10" />
            <Skeleton className="h-4 w-96 max-w-full bg-white/10" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-10 w-24 bg-white/10" />
            <Skeleton className="h-10 w-24 bg-white/10" />
            <Skeleton className="h-10 w-24 bg-white/10" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="rounded-2xl border border-bg-border bg-bg-card p-5 shadow-surface-soft space-y-4">
          <Skeleton className="h-5 w-56 bg-white/10" />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-24 rounded-2xl bg-white/10" />
            ))}
          </div>
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full rounded-xl bg-white/10" />
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-bg-border bg-bg-card p-5 shadow-surface-soft space-y-4">
          <Skeleton className="h-5 w-40 bg-white/10" />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-20 rounded-2xl bg-white/10" />
            ))}
          </div>
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full rounded-xl bg-white/10" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
