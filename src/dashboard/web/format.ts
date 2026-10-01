const inrFormat = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const istFormat = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const istTimeFormat = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const priceFormat = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "15:04:05" in IST. */
export function istTime(iso: string): string {
  return istTimeFormat.format(new Date(iso));
}

/** 1,234.50 (no currency sign, for prices in tables). */
export function price(n: number): string {
  return priceFormat.format(n);
}

/** ₹1,23,456.50 */
export function inr(n: number): string {
  return inrFormat.format(n);
}

/** "1 Oct, 15:30" in IST, whatever the browser's time zone. */
export function istDateTime(iso: string): string {
  return istFormat.format(new Date(iso));
}

/** Mantine colour for a profit or loss: teal up, red down, default for zero or unknown. */
export function pnlColor(n: number | undefined): string | undefined {
  return n === undefined || n === 0 ? undefined : n > 0 ? "teal" : "red";
}

const dayFormat = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

/** "Mon, 5 Oct" for a YYYY-MM-DD date. */
export function dayLabel(date: string): string {
  return dayFormat.format(new Date(`${date}T00:00:00Z`));
}

/** "5s ago", "3 min ago", "2 h ago". */
export function ago(iso: string, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** +12.30 / −4.50 with a real minus sign. */
export function signed(n: number, digits = 2): string {
  const text = Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return n > 0 ? `+${text}` : n < 0 ? `−${text}` : text;
}
