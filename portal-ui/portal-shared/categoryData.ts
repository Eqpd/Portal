import { Radio, Target, Zap, Car, Battery, Package } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const ALL_CATEGORIES = [
  "portable_radios",
  "firearms",
  "taser",
  "vehicle",
  "battery_packs",
] as const;

export type CategorySlug = typeof ALL_CATEGORIES[number];

export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  portable_radios: Radio,
  firearms:        Target,
  taser:           Zap,
  vehicle:         Car,
  battery_packs:   Battery,
};

export const CATEGORY_LABELS: Record<string, string> = {
  portable_radios: "Radios",
  firearms:        "Firearms",
  taser:           "Tasers",
  vehicle:         "Vehicles",
  battery_packs:   "Batteries",
};

export function getCategoryIcon(category: string | null | undefined): LucideIcon {
  if (!category) return Package;
  return CATEGORY_ICONS[category] ?? Package;
}

export function getCategoryLabel(category: string | null | undefined): string {
  if (!category) return "Unknown";
  return CATEGORY_LABELS[category] ?? category.replace(/_/g, " ");
}
