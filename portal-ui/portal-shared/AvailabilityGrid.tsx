import { ALL_CATEGORIES, getCategoryIcon, getCategoryLabel } from "./categoryData";

interface AvailabilityRow {
  category: string;
  available: number;
  total: number;
}

interface AvailabilityGridProps {
  availableCounts: AvailabilityRow[];
}

export function AvailabilityGrid({ availableCounts }: AvailabilityGridProps) {
  const mergedCounts = ALL_CATEGORIES.map((cat) => {
    const found = availableCounts.find((r) => r.category === cat);
    return found ?? { category: cat, available: 0, total: 0 };
  });

  return (
    <div className="p-4 flex flex-col h-full overflow-hidden">
      <h3 className="text-2xl font-bold mb-3 flex-shrink-0 text-slate-900">Available Equipment</h3>
      <div
        className="flex-1"
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem 1.5rem", alignContent: "stretch" }}
      >
        {mergedCounts.map((row) => {
          const Icon = getCategoryIcon(row.category);
          const pct = row.total > 0 ? row.available / row.total : 0;
          const barColor =
            pct === 0 && row.total > 0 ? "bg-red-400"
            : pct < 0.4 && row.total > 0 ? "bg-amber-400"
            : row.total === 0 ? "bg-slate-200"
            : "bg-emerald-400";
          const dimmed = row.total === 0;
          return (
            <div key={row.category}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Icon className={`w-7 h-7 flex-shrink-0 ${dimmed ? "text-slate-300" : "text-slate-500"}`} />
                  <span className={`text-xl font-semibold truncate ${dimmed ? "text-slate-300" : "text-slate-700"}`}>
                    {getCategoryLabel(row.category)}
                  </span>
                </div>
                <span className={`text-xl font-bold tabular-nums ml-1 flex-shrink-0 ${dimmed ? "text-slate-300" : "text-slate-900"}`}>
                  {row.available}<span className="text-lg font-normal text-slate-400">/{row.total}</span>
                </span>
              </div>
              <div className="h-3 rounded-full bg-slate-100">
                <div
                  className={`h-3 rounded-full transition-all duration-300 ${barColor}`}
                  style={{ width: row.total > 0 ? `${pct * 100}%` : "0%" }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
