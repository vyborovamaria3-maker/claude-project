#!/usr/bin/env node
// Автоматический тест SearchBar
// Запуск: node tests/auto-test.js

const { chromium } = require("playwright");

const TEST_URL = "http://127.0.0.1:50794/trade/analysis";
const TEST_MINT = "Bi6z17iWRMRejRHM56LHEdD5UQVsoexho5aeTR7kpump";

async function runTests() {
  console.log("🚀 Запуск автоматических тестов...\n");

  const browser = await chromium.launch({ headless: false }); // headless: false чтобы видеть браузер
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();

  const logs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[SearchBar]") || text.includes("[PumpFunChart]") || text.includes("[analytics]")) {
      logs.push({ type: msg.type(), text });
      console.log(`[${msg.type().toUpperCase()}] ${text}`);
    }
  });

  page.on("pageerror", (err) => {
    console.error("❌ Page Error:", err.message);
  });

  try {
    // 1. Открываем страницу
    console.log("📄 Открываем страницу...");
    await page.goto(TEST_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // 2. Тест Paste
    console.log("\n📋 Тест 1: Кнопка Paste");
    await page.evaluate((mint) => navigator.clipboard.writeText(mint), TEST_MINT);
    await page.click('[data-tag="trade.paste_btn"]');
    await page.waitForTimeout(500);

    const inputValue = await page.inputValue('[data-tag="trade.search_input"]');
    if (inputValue === TEST_MINT) {
      console.log("✅ Значение вставлено корректно");
    } else {
      console.error("❌ Значение не совпадает. Ожидалось:", TEST_MINT, "Получено:", inputValue);
    }

    // 3. Тест кнопки Анализировать
    console.log("\n🔍 Тест 2: Кнопка Анализировать");
    // Используем first() т.к. может быть дубликат от Strict Mode
    const button = page.locator('[data-tag="trade.search_submit"]').first();
    const isEnabled = await button.isEnabled();
    console.log("Кнопка enabled:", isEnabled);

    if (isEnabled) {
      await button.click();
      console.log("✅ Клик выполнен");
      await page.waitForTimeout(2000);
    } else {
      console.error("❌ Кнопка disabled");
    }

    // 4. Проверка логов
    console.log("\n📊 Проверка логов:");
    const searchBarLogs = logs.filter((l) => l.text.includes("[SearchBar]"));
    const chartLogs = logs.filter((l) => l.text.includes("[PumpFunChart]") || l.text.includes("[analytics]"));

    console.log(`  SearchBar логов: ${searchBarLogs.length}`);
    console.log(`  Chart логов: ${chartLogs.length}`);

    if (searchBarLogs.length === 0) {
      console.error("❌ Нет логов SearchBar!");
    }
    if (chartLogs.length === 0) {
      console.error("❌ Нет логов графика!");
    }

    // 4. Проверка DOM
    console.log("\n🔍 Проверка DOM:");
    const chartVisible = await page.locator('[data-tag="components.pump_fun_chart"]').isVisible().catch(() => false);
    console.log("График виден:", chartVisible);
    
    // Проверяем наличие ошибок на странице
    const errors = await page.evaluate(() => {
      return window.errors || [];
    });
    if (errors.length > 0) {
      console.log("❌ Ошибки на странице:", errors);
    }
    
    // Проверяем console errors
    const consoleErrors = [];
    page.on('pageerror', err => {
      consoleErrors.push(err.message);
    });
    await page.waitForTimeout(500);
    if (consoleErrors.length > 0) {
      console.log("❌ Console errors:", consoleErrors);
    }

    // Сохраняем скриншот
    await page.screenshot({ path: "tests/screenshot.png" });
    console.log("\n📸 Скриншот сохранен: tests/screenshot.png");

    console.log("\n✅ Тесты завершены");

  } catch (e) {
    console.error("❌ Ошибка теста:", e.message);
  } finally {
    await browser.close();
  }
}

runTests().catch(console.error);
