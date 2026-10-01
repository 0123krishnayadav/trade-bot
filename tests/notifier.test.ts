import { expect, test } from "bun:test";
import { createNotifier, LogNotifier, TelegramNotifier } from "../src/alerts/notifier";

function telegram(status = 200) {
  const sent: { url: string; body: { chat_id: string; text: string; disable_web_page_preview: boolean } }[] = [];
  let now = 0;
  const notifier = new TelegramNotifier({
    botToken: "123:abc",
    chatId: "42",
    prefix: "[paper]",
    minIntervalMs: 0,
    now: () => now,
    fetchFn: (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status });
    }) as unknown as typeof fetch,
  });
  return { notifier, sent, advance: (ms: number) => (now += ms) };
}

test("sends prefixed messages to the chat, in order", async () => {
  const { notifier, sent } = telegram();
  notifier.notify("entered");
  notifier.notify("exited");
  await notifier.flush();
  expect(sent.map((s) => s.body)).toEqual([
    { chat_id: "42", text: "[paper] entered", disable_web_page_preview: true },
    { chat_id: "42", text: "[paper] exited", disable_web_page_preview: true },
  ]);
  expect(sent[0]!.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
});

test("the same text isn't repeated within 10 minutes", async () => {
  const { notifier, sent, advance } = telegram();
  notifier.notify("error: x");
  notifier.notify("error: x");
  advance(10 * 60_000);
  notifier.notify("error: x");
  await notifier.flush();
  expect(sent).toHaveLength(2);
});

test("a failing Telegram never throws", async () => {
  const { notifier } = telegram(500);
  expect(() => notifier.notify("hello")).not.toThrow();
  await notifier.flush();
});

test("without Telegram settings, alerts go to the log", () => {
  expect(createNotifier({}, {})).toBeInstanceOf(LogNotifier);
  expect(createNotifier({ telegram: { botToken: "t", chatId: "c" } }, {})).toBeInstanceOf(TelegramNotifier);
});
