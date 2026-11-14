const relative = new Intl.RelativeTimeFormat("ja", { numeric: "always" });
const absolute = new Intl.DateTimeFormat("ja", { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("ja", { dateStyle: "medium" });

/** 「12 分前」「3 日前」のような表示。1 か月以上前は日付にする。 */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso));
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relative.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return relative.format(-days, "day");
  return dateOnly.format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return absolute.format(new Date(iso));
}
