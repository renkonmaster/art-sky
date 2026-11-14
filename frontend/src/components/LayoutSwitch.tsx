import type { GalleryLayout } from "../lib/useLayout.ts";

const OPTIONS: ReadonlyArray<{ value: GalleryLayout; label: string; icon: string }> = [
  { value: "feed", label: "1 枚ずつ", icon: "M5 4h14v7H5zM5 13h14v7H5z" },
  { value: "tiles", label: "タイル", icon: "M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z" },
];

/** ギャラリーの配置を切り替えるボタン。 */
export function LayoutSwitch({ layout, onChange }: { layout: GalleryLayout; onChange: (layout: GalleryLayout) => void }) {
  return (
    <div className="segmented" role="group" aria-label="配置">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={layout === option.value}
          onClick={() => onChange(option.value)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d={option.icon} fill="currentColor" />
          </svg>
          {option.label}
        </button>
      ))}
    </div>
  );
}
