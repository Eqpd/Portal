import { useRef } from "react";
import { getCategoryIcon } from "./categoryData";

export interface RecentMovement {
  id: string;
  action: "check_out" | "check_in";
  timestamp: string;
  equipmentName: string;
  equipmentCategory: string;
  userFirstName: string;
  userLastName: string;
  userQid: string;
}

interface RecentMovementsProps {
  recentMovements: RecentMovement[];
  scrollRef?: React.RefObject<HTMLDivElement>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
}

function timeAgo(ts: string): string {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function RecentMovements({ recentMovements, scrollRef, onScroll }: RecentMovementsProps) {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = scrollRef ?? internalRef;

  return (
    <div className="p-4 flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <h3 className="text-2xl font-bold text-slate-900">Recent Movements</h3>
        {recentMovements.length > 0 && (
          <span className="text-xs text-slate-400">{recentMovements.length} shown</span>
        )}
      </div>
      <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto space-y-1.5">
        {recentMovements.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-3xl mb-2">📋</div>
            <p className="text-xs text-slate-400">No recent movements</p>
            <p className="text-xs mt-1 text-slate-300">Transactions will appear here</p>
          </div>
        ) : (
          recentMovements.map((mv) => {
            const Icon = getCategoryIcon(mv.equipmentCategory);
            const isOut = mv.action === "check_out";
            const colors = isOut
              ? { row: "bg-green-50 border-green-100", icon: "bg-green-100 text-green-600", badge: "bg-green-100 text-green-700", sub: "text-slate-500" }
              : { row: "bg-blue-50 border-blue-100", icon: "bg-blue-100 text-blue-600", badge: "bg-blue-100 text-blue-700", sub: "text-slate-500" };
            const ts = new Date(mv.timestamp);
            const dateStr = ts.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
            const timeStr = ts.toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit", hour12: true });
            return (
              <div key={mv.id} className={`flex items-center gap-3 p-3 rounded-lg border ${colors.row}`}>
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${colors.icon}`}>
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm truncate text-slate-800">{mv.equipmentName}</div>
                  <div className={`text-xs truncate ${colors.sub}`}>{mv.userFirstName} {mv.userLastName} · {mv.userQid}</div>
                  <div className={`text-xs ${colors.sub} opacity-75`}>{dateStr}, {timeStr} · {timeAgo(mv.timestamp)}</div>
                </div>
                <div className={`text-sm font-bold px-2 py-1 rounded flex-shrink-0 ${colors.badge}`}>{isOut ? "OUT" : "IN"}</div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
