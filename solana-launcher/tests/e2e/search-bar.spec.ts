import { test, expect } from "@playwright/test";

const TEST_MINT = "Bi6z17iWRMRejRHM56LHEdD5UQVsoexho5aeTR7kpump";

test.describe("SearchBar", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("http://127.0.0.1:50794/trade/analysis");
  });

  test("Paste button works and logs correctly", async ({ page }) => {
    // Устанавливаем clipboard
    await page.evaluate((mint) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", mint);
      navigator.clipboard.writeText(mint);
    }, TEST_MINT);

    // Ловим консольные логи
    const logs: string[] = [];
    page.on("console", (msg) => {
      if (msg.text().includes("[SearchBar]")) {
        logs.push(msg.text());
      }
    });

    // Кликаем Paste
    await page.click('[data-tag="trade.paste_btn"]');

    // Ждем логи
    await page.waitForTimeout(500);

    // Проверяем логи
    expect(logs.some((l) => l.includes("Paste button clicked"))).toBeTruthy();
    expect(logs.some((l) => l.includes("Setting value to:"))).toBeTruthy();

    // Проверяем что значение в input
    const inputValue = await page.inputValue('[data-tag="trade.search_input"]');
    expect(inputValue).toBe(TEST_MINT);
  });

  test("Analyze button is enabled after paste", async ({ page }) => {
    // Устанавливаем значение
    await page.fill('[data-tag="trade.search_input"]', TEST_MINT);

    // Проверяем что кнопка активна
    const button = page.locator('[data-tag="trade.search_submit"]');
    await expect(button).toBeEnabled();
  });

  test("Analyze button logs correctly", async ({ page }) => {
    // Заполняем поле
    await page.fill('[data-tag="trade.search_input"]', TEST_MINT);

    // Ловим логи
    const logs: string[] = [];
    page.on("console", (msg) => {
      if (msg.text().includes("[SearchBar]")) {
        logs.push(msg.text());
      }
    });

    // Кликаем Анализировать
    await page.click('[data-tag="trade.search_submit"]');

    // Ждем логи
    await page.waitForTimeout(500);

    // Проверяем логи
    expect(logs.some((l) => l.includes("Button clicked"))).toBeTruthy();
    expect(logs.some((l) => l.includes(TEST_MINT))).toBeTruthy();
  });

  test("Full flow: Paste → Analyze → Chart loads", async ({ page }) => {
    const logs: string[] = [];
    page.on("console", (msg) => {
      logs.push(msg.text());
    });

    // 1. Paste
    await page.evaluate((mint) => navigator.clipboard.writeText(mint), TEST_MINT);
    await page.click('[data-tag="trade.paste_btn"]');
    await page.waitForTimeout(300);

    // 2. Analyze
    await page.click('[data-tag="trade.search_submit"]');
    await page.waitForTimeout(1000);

    // 3. Проверяем логи графика
    expect(logs.some((l) => l.includes("[PumpFunChart]"))).toBeTruthy();
    expect(logs.some((l) => l.includes("[analytics]"))).toBeTruthy();

    // 4. Проверяем что график отобразился
    await expect(page.locator('[data-tag="components.pump_fun_chart"]')).toBeVisible();
  });
});
