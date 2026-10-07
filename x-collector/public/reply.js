"use strict";
let token = "",
  active = "accounts";
const labels = {
  accounts: "Аккаунты",
  lore: "Персонажи",
  campaigns: "Кампании",
  drafts: "Ответы",
  consents: "Согласия",
  stats: "Статистика",
  alerts: "Алерты",
};
const el = (id) => document.getElementById(id);
function node(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function field(form, label, name, type = "text", value = "", options) {
  const wrap = node("label", label);
  const input = node(
    type === "textarea" ? "textarea" : type === "select" ? "select" : "input",
  );
  input.name = name;
  if (type !== "textarea" && type !== "select") input.type = type;
  if (type === "select")
    for (const [v, title] of options ?? []) {
      const o = node("option", title);
      o.value = v;
      input.append(o);
    }
  input.value = String(value ?? "");
  wrap.append(input);
  form.append(wrap);
  return input;
}
function button(parent, text, action) {
  const b = node("button", text);
  b.type = "button";
  b.addEventListener("click", () => run(action));
  parent.append(b);
  return b;
}
function form(title, submit) {
  const section = node("section");
  section.append(node("h2", title));
  const f = node("form");
  f.addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      const b = f.querySelector("button[type=submit]");
      b.disabled = true;
      try {
        await submit(Object.fromEntries(new FormData(f)));
        await refresh();
      } finally {
        b.disabled = false;
      }
    });
  });
  section.append(f);
  return {
    section,
    f,
    end() {
      const b = node("button", "Сохранить");
      b.type = "submit";
      f.append(b);
      return section;
    },
  };
}
async function api(path, method = "GET", data) {
  const r = await fetch("/api/reply" + path, {
    method,
    headers: { "X-Reply-Token": token, "Content-Type": "application/json" },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    signal: AbortSignal.timeout(65000),
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error ?? "HTTP " + r.status);
  return result;
}
async function run(action) {
  el("error").textContent = "";
  try {
    await action();
  } catch (e) {
    el("error").textContent = e.message;
  }
}
function article(container, title, details) {
  const item = node("article");
  item.append(node("h3", title));
  if (details) item.append(node("pre", details));
  container.append(item);
  return item;
}
function json(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Error("Некорректный JSON в настройках");
  }
}
function tabs() {
  el("tabs").replaceChildren();
  for (const [id, title] of Object.entries(labels)) {
    const b = button(el("tabs"), title, async () => {
      active = id;
      location.hash = id;
      await refresh();
    });
    if (id === active) b.className = "active";
  }
}
async function refresh() {
  const requested = active;
  const data = await api("/" + requested);
  if (active !== requested) return;
  tabs();
  render(data);
}
function render(data) {
  const content = el("content");
  content.replaceChildren();
  content.dataset.view = active;
  if (active === "accounts") {
    const add = form("Подключить X-аккаунт", async (v) => {
      await api("/accounts", "POST", v);
      add.f.reset();
    });
    field(add.f, "OAuth 2.0 user access token", "access_token", "password");
    field(add.f, "Refresh token (необязательно)", "refresh_token", "password");
    field(add.f, "Прокси (необязательно)", "proxy_string", "password");
    field(add.f, "Timezone", "timezone", "text", "Europe/Moscow");
    add.f.addEventListener("formdata", (e) => {
      if (!e.formData.get("proxy_string")) e.formData.delete("proxy_string");
      if (!e.formData.get("refresh_token")) e.formData.delete("refresh_token");
    });
    content.append(add.end());
    for (const a of data) {
      const row = article(
        content,
        `#${a.id} @${a.x_username ?? "не подтверждён"} · ${a.status}`,
        `Прокси: ${a.proxy_status}\nTimezone: ${a.timezone}\nПроверка: ${a.last_health_at ?? "нет"}`,
      );
      button(row, "Пауза", async () => {
        await api("/accounts/" + a.id, "PATCH", { status: "paused" });
        await refresh();
      });
      button(row, "Проверить / возобновить", async () => {
        await api("/accounts/" + a.id, "PATCH", { status: "ready" });
        await refresh();
      });
      const edit = form("Обновить токен / timezone", async (v) => {
        if (!v.access_token) delete v.access_token;
        await api("/accounts/" + a.id, "PATCH", v);
        edit.f.reset();
      });
      field(edit.f, "Новый access token", "access_token", "password");
      field(edit.f, "Timezone", "timezone", "text", a.timezone);
      row.append(edit.end());
      const proxy = form("Заменить прокси", async (v) => {
        await api("/accounts/" + a.id + "/proxy", "POST", v);
        proxy.f.reset();
      });
      field(proxy.f, "Строка прокси", "proxy_string", "password");
      row.append(proxy.end());
      button(row, "Удалить аккаунт и его данные", async () => {
        if (confirm("Удалить аккаунт, его кампанию и ответы?")) {
          await api("/accounts/" + a.id, "DELETE");
          await refresh();
        }
      });
    }
  } else if (active === "lore") {
    const add = form("Новый персонаж", (v) => api("/lore", "POST", v));
    for (const [name, label] of [
      ["name", "Имя"],
      ["style", "Стиль"],
      ["country", "Страна (ISO код, необязательно)"],
      ["bio", "Bio"],
      ["system_prompt", "Инструкции"],
    ])
      field(
        add.f,
        label,
        name,
        name === "name" || name === "style" ? "text" : "textarea",
      );
    content.append(add.end());
    for (const lore of data) {
      const row = article(
        content,
        `#${lore.id} ${lore.name}`,
        lore.style + "\n" + lore.bio,
      );
      const edit = form("Редактировать персонажа", (v) =>
        api("/lore/" + lore.id, "PATCH", v),
      );
      for (const k of ["name", "style", "country", "bio", "system_prompt"])
        field(
          edit.f,
          k,
          k,
          k === "bio" || k === "system_prompt" ? "textarea" : "text",
          lore[k],
        );
      row.append(edit.end());
      const example = form("Добавить пример для RAG", (v) =>
        api("/lore/" + lore.id + "/examples", "POST", v),
      );
      field(example.f, "Исходный пост", "tweet_text", "textarea");
      field(example.f, "Ответ в стиле персонажа", "reply_text", "textarea");
      row.append(example.end());
      button(row, "Показать примеры", async () => {
        const examples = await api("/lore/" + lore.id + "/examples");
        const pre = node("pre", JSON.stringify(examples, null, 2));
        row.append(pre);
      });
    }
  } else if (active === "campaigns") {
    const add = form("Новая кампания", (v) =>
      api("/campaigns", "POST", {
        account_id: v.account_id,
        lore_id: v.lore_id,
      }),
    );
    field(add.f, "Account ID", "account_id", "number");
    field(add.f, "Lore ID", "lore_id", "number");
    content.append(add.end());
    for (const campaign of data) {
      const row = article(
        content,
        `#${campaign.id} · account ${campaign.account_id} · ${campaign.status}`,
      );
      button(row, "Старт", async () => {
        await api("/campaigns/" + campaign.id + "/start", "POST", {});
        await refresh();
      });
      button(row, "Стоп", async () => {
        await api("/campaigns/" + campaign.id + "/stop", "POST", {});
        await refresh();
      });
      const settings = form("Лимиты и режим", (v) =>
        api("/campaigns/" + campaign.id, "PATCH", {
          lore_id: v.lore_id,
          settings: json(v.settings),
        }),
      );
      field(settings.f, "Lore ID", "lore_id", "number", campaign.lore_id);
      field(
        settings.f,
        "Настройки",
        "settings",
        "textarea",
        JSON.stringify(campaign.settings_json, null, 2),
      );
      row.append(settings.end());
      const filters = form("Фильтры", (v) =>
        api("/campaigns/" + campaign.id + "/filters", "PATCH", json(v.filters)),
      );
      field(
        filters.f,
        "Фильтры",
        "filters",
        "textarea",
        JSON.stringify(campaign.filters_json, null, 2),
      );
      row.append(filters.end());
      const source = form("Добавить источник", (v) =>
        api("/campaigns/" + campaign.id + "/sources", "POST", {
          ...v,
          priority: Number(v.priority),
        }),
      );
      field(source.f, "Тип", "type", "select", "search", [
        ["search", "Поиск"],
        ["list", "X List ID"],
      ]);
      field(source.f, "Запрос или List ID", "value");
      field(source.f, "Приоритет 1–10", "priority", "number", 5);
      row.append(source.end());
      button(row, "Показать источники", async () => {
        const sources = await api("/campaigns/" + campaign.id + "/sources");
        for (const s of sources) {
          const item = article(
            row,
            `#${s.id} ${s.type} · priority ${s.priority}`,
            s.value,
          );
          button(item, "Удалить источник", async () => {
            await api("/sources/" + s.id, "DELETE");
            item.remove();
          });
        }
      });
      const blacklist = form("Чёрный список", (v) =>
        api("/campaigns/" + campaign.id + "/blacklists", "POST", v),
      );
      field(blacklist.f, "Тип", "type", "select", "word", [
        ["word", "Слово"],
        ["account", "Username"],
      ]);
      field(blacklist.f, "Значение", "value");
      row.append(blacklist.end());
      button(row, "Показать чёрный список", async () => {
        for (const b of await api(
          "/campaigns/" + campaign.id + "/blacklists",
        )) {
          const item = article(row, b.type, b.value);
          button(item, "Удалить", async () => {
            await api("/blacklists/" + b.id, "DELETE");
            item.remove();
          });
        }
      });
    }
  } else if (active === "drafts") {
    for (const d of data) {
      const row = article(
        content,
        `#${d.id} · ${d.status} · campaign ${d.campaign_id}`,
        `@${d.tweet_json.username}\n${d.tweet_json.text}\n\n${d.last_error ?? ""}`,
      );
      const reply = field(
        row,
        "Ответ",
        "reply_text",
        "textarea",
        d.reply_text ?? "",
      );
      if (d.status === "review") {
        button(row, "Одобрить ответ", async () => {
          await api("/drafts/" + d.id + "/approve", "POST", {
            reply_text: reply.value,
          });
          await refresh();
        });
        button(row, "Сгенерировать заново", async () => {
          await api("/drafts/" + d.id + "/regenerate", "POST", {});
          await refresh();
        });
      }
      if (["pending", "review", "approved", "failed"].includes(d.status))
        button(row, "Отклонить", async () => {
          await api("/drafts/" + d.id + "/reject", "POST", {});
          await refresh();
        });
      if (d.status === "failed")
        button(row, "Сгенерировать заново", async () => {
          await api("/drafts/" + d.id + "/regenerate", "POST", {});
          await refresh();
        });
      if (d.status === "uncertain") {
        const f = form("Сверить уже опубликованный ответ", (v) =>
          api("/drafts/" + d.id + "/reconcile", "POST", v),
        );
        field(f.f, "X reply ID", "x_reply_id");
        row.append(f.end());
      }
    }
  } else if (active === "consents") {
    content.append(
      node(
        "p",
        "Указывайте согласие получателя на ответы и подтверждающий источник. Статус аккаунта или подписка не заменяют согласие.",
        "muted",
      ),
    );
    const add = form("Согласие получателя", (v) =>
      api("/consents", "POST", {
        ...v,
        expires_at: new Date(v.expires_at).toISOString(),
      }),
    );
    field(add.f, "X author ID", "author_id");
    field(add.f, "Подтверждение согласия", "evidence", "textarea");
    field(add.f, "Срок действия", "expires_at", "datetime-local");
    content.append(add.end());
    for (const c of data) {
      const row = article(
        content,
        c.author_id,
        c.evidence + "\n" + c.expires_at,
      );
      button(row, "Отозвать", async () => {
        await api("/consents/" + c.id, "DELETE");
        await refresh();
      });
    }
  } else {
    for (const row of data)
      article(
        content,
        active === "stats" ? row.status : row.type,
        active === "stats"
          ? String(row.count)
          : row.message + "\n" + row.created_at,
      );
  }
  if (!data.length) content.append(node("p", "Записей пока нет", "muted"));
}
el("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    token = el("token").value.trim();
    await api("/me");
    el("token").value = "";
    el("login").hidden = true;
    el("workspace").hidden = false;
    await refresh();
  });
});
el("refresh").onclick = () => run(refresh);
el("logout").onclick = () => {
  token = "";
  el("content").replaceChildren();
  el("workspace").hidden = true;
  el("login").hidden = false;
};
el("revoke").onclick = () =>
  run(async () => {
    await api("/token/revoke", "POST", {});
    el("logout").click();
  });
addEventListener("hashchange", () => {
  if (labels[location.hash.slice(1)]) {
    active = location.hash.slice(1);
    if (token) run(refresh);
  }
});
if (labels[location.hash.slice(1)]) active = location.hash.slice(1);
