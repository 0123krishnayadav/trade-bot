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
