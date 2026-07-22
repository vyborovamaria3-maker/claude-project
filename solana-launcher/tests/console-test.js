// Скрипт для автоматического тестирования SearchBar в консоли браузера
// Как использовать: Открой http://127.0.0.1:50794, затем вставь этот код в консоль (F12)

(function runTests() {
  console.log("🧪 Запуск тестов SearchBar...\n");

  const TEST_MINT = "Bi6z17iWRMRejRHM56LHEdD5UQVsoexho5aeTR7kpump";
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;

  // Перехватываем логи
  console.log = (...args) => {
    const msg = args.join(" ");
    logs.push({ type: "log", msg, time: Date.now() });
    originalLog.apply(console, args);
  };

  console.error = (...args) => {
    const msg = args.join(" ");
    logs.push({ type: "error", msg, time: Date.now() });
    originalError.apply(console, args);
  };

  async function testPasteButton() {
    console.log("📋 Тест 1: Кнопка Paste");
    try {
      // Устанавливаем clipboard
      await navigator.clipboard.writeText(TEST_MINT);

      // Кликаем кнопку
      const pasteBtn = document.querySelector('[data-tag="trade.paste_btn"]');
      if (!pasteBtn) throw new Error("Кнопка Paste не найдена");

      pasteBtn.click();
      await new Promise((r) => setTimeout(r, 500));

      // Проверяем логи
      const pasteLogs = logs.filter(
        (l) => l.msg.includes("[SearchBar]") && l.msg.includes("Paste")
      );

      if (pasteLogs.length > 0) {
        console.log("✅ Кнопка Paste работает");
        pasteLogs.forEach((l) => console.log("  →", l.msg));
      } else {
        console.error("❌ Логи Paste не найдены");
      }

      // Проверяем значение в input
      const input = document.querySelector('[data-tag="trade.search_input"]');
      if (input && input.value === TEST_MINT) {
        console.log("✅ Значение установлено в input");
      } else {
        console.error("❌ Значение не установлено. Текущее:", input?.value);
      }
    } catch (e) {
      console.error("❌ Ошибка теста Paste:", e.message);
    }
  }

  async function testAnalyzeButton() {
    console.log("\n🔍 Тест 2: Кнопка Анализировать");
    try {
      // Устанавливаем значение
      const input = document.querySelector('[data-tag="trade.search_input"]');
      if (!input) throw new Error("Input не найден");

      input.value = TEST_MINT;
      input.dispatchEvent(new Event("input", { bubbles: true }));

      await new Promise((r) => setTimeout(r, 100));

      // Кликаем кнопку
      const analyzeBtn = document.querySelector('[data-tag="trade.search_submit"]');
      if (!analyzeBtn) throw new Error("Кнопка Анализировать не найдена");

      const isDisabled = analyzeBtn.disabled;
      console.log("Кнопка disabled:", isDisabled);

      if (!isDisabled) {
        analyzeBtn.click();
        console.log("✅ Клик по кнопке Анализировать выполнен");
      } else {
        console.error("❌ Кнопка Анализировать disabled");
      }

      await new Promise((r) => setTimeout(r, 500));

      // Проверяем логи
      const analyzeLogs = logs.filter(
        (l) => l.msg.includes("[SearchBar]") && l.msg.includes("clicked")
      );

      if (analyzeLogs.length > 0) {
        console.log("✅ Логи кнопки найдены:");
        analyzeLogs.forEach((l) => console.log("  →", l.msg));
      } else {
        console.error("❌ Логи кнопки не найдены");
        console.log("Все логи:", logs.filter((l) => l.msg.includes("[SearchBar]")));
      }
    } catch (e) {
      console.error("❌ Ошибка теста Анализировать:", e.message);
    }
  }

  async function testChartLoading() {
    console.log("\n📈 Тест 3: Загрузка графика");
    try {
      await new Promise((r) => setTimeout(r, 2000));

      const chartLogs = logs.filter(
        (l) =>
          l.msg.includes("[PumpFunChart]") ||
          l.msg.includes("[analytics]") ||
          l.msg.includes("[chart]")
      );

      if (chartLogs.length > 0) {
        console.log("✅ Логи графика найдены:");
        chartLogs.forEach((l) => console.log("  →", l.msg.substring(0, 100)));
      } else {
        console.error("❌ Логи графика не найдены");
      }

      // Проверяем DOM
      const chart = document.querySelector('[data-tag="components.pump_fun_chart"]');
      if (chart) {
        console.log("✅ Компонент графика найден в DOM");
      } else {
        console.error("❌ Компонент графика не найден");
      }
    } catch (e) {
      console.error("❌ Ошибка теста графика:", e.message);
    }
  }

  async function runAll() {
    await testPasteButton();
    await testAnalyzeButton();
    await testChartLoading();

    console.log("\n📊 Итоговая статистика:");
    const searchBarLogs = logs.filter((l) => l.msg.includes("[SearchBar]"));
    const chartLogs = logs.filter(
      (l) => l.msg.includes("[PumpFunChart]") || l.msg.includes("[analytics]")
    );
    const errors = logs.filter((l) => l.type === "error");

    console.log(`  SearchBar логов: ${searchBarLogs.length}`);
    console.log(`  Chart логов: ${chartLogs.length}`);
    console.log(`  Ошибок: ${errors.length}`);

    if (errors.length > 0) {
      console.log("\n❌ Ошибки:");
      errors.forEach((e) => console.error("  →", e.msg));
    }

    // Восстанавливаем оригинальные console методы
    console.log = originalLog;
    console.error = originalError;

    console.log("\n✅ Тесты завершены");
  }

  // Запускаем тесты
  runAll().catch(console.error);
})();
