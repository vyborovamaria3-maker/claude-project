"""Dedicated collector database explorer/editor; never uses product read-only DSNs."""
from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from .auth import require_admin
from .database import _mask_nested, is_sensitive

LABELS = {
    'twitter_tweets': 'Твиты', 'twitter_profiles': 'Профили авторов',
    'tweet_token_links': 'Связи твитов и токенов', 'x_accounts': 'Аккаунты коллектора',
    'x_workers': 'Рабочие процессы', 'x_tasks': 'Очередь задач',
    'x_tasks_dlq': 'Задачи с ошибками', 'outbox': 'Очередь уведомлений',
    'scrape_runs': 'История сбора', 'proxies': 'Прокси',
    'author_token_stats': 'Статистика авторов по токенам',
    'author_reputation': 'Репутация авторов', 'author_clusters': 'Группы авторов',
    'mint_events': 'События токенов', 'mint_hype_scores': 'Оценки интереса',
    'mint_ultra_scores': 'Сводные оценки', 'ml_models': 'Модели прогнозирования',
    'retention_policies': 'Правила хранения', 'schema_migrations': 'История миграций',
}

LABELS.update({
    'feature_flags': 'Переключатели функций', 'account_daily_stats': 'Статистика аккаунтов по дням',
    'account_state_log': 'История состояний аккаунтов', 'session_rotations': 'История смены сессий',
    'table_size_snapshots': 'Размеры таблиц во времени', 'author_cooccurrence': 'Совместные упоминания авторов',
    'mint_similarity': 'Сходство токенов', 'author_lead_stats': 'Авторы ранних упоминаний',
    'author_pagerank': 'Влиятельность авторов в графе', 'backtest_runs': 'Запуски проверки стратегий',
    'backtest_trades': 'Сделки проверки стратегий', 'ml_feature_snapshots': 'Данные для прогнозов',
    'strategies': 'Торговые стратегии', 'mint_milestones': 'Ключевые этапы токенов',
    'tweet_sentiment': 'Тональность твитов', 'tweet_entities': 'Сущности из твитов',
    'tweet_embeddings': 'Векторные представления твитов', 'topics': 'Темы', 'tweet_topics': 'Темы отдельных твитов',
    'tweet_toxicity': 'Токсичность твитов', 'tweet_languages': 'Языки твитов',
    'sentiment_lexicon': 'Словарь тональности', 'kol_tiers': 'Уровни влиятельных авторов',
    'cluster_members': 'Участники групп авторов', 'author_behavior': 'Поведение авторов',
    'mint_attention_snapshots': 'История внимания к токенам', 'signal_history': 'История сигналов',
    'graph_signal_history': 'История графовых сигналов',
    'graph_priority_events': 'Приоритетные события графа',
    'mint_metrics_1m': 'Метрики токенов по минутам', 'mint_metrics_1h': 'Метрики токенов по часам',
    'mint_metrics_1d': 'Метрики токенов по дням', 'mint_metrics_1w': 'Метрики токенов по неделям',
    'author_metrics_1d': 'Метрики авторов по дням',
})
VIEW_NAMES = {
    'mint_summary':'Сводка токенов', 'mint_daily_funnel':'Воронка токенов по дням',
    'mint_bursts':'Всплески упоминаний', 'top_tweets':'Популярные твиты', 'author_profile':'Сводка авторов',
    'shillers':'Активные продвиженцы', 'fresh_burners':'Новые активные аккаунты', 'rising_authors':'Растущие авторы',
    'coordinated_tweets':'Согласованные публикации', 'coordinated_accounts':'Согласованные аккаунты',
    'author_graph':'Граф авторов', 'hourly_activity':'Активность по часам', 'mint_overlap':'Общие авторы токенов',
    'trending_words':'Популярные слова', 'cashtag_trends':'Тренды тикеров', 'mint_lifecycle':'Жизненный цикл токенов',
    'worker_efficiency':'Эффективность процессов', 'account_health':'Состояние аккаунтов',
    'pipeline_daily':'Сбор по дням', 'top_authors':'Популярные авторы', 'coordinated':'Согласованные аккаунты',
    'author_token_stats':'Статистика авторов по токенам', 'author_cooccurrence':'Совместные упоминания',
    'daily_mint_stats':'Статистика токенов по дням', 'active_tasks':'Активные задачи',
    'mint_sentiment_daily':'Тональность токенов по дням', 'author_sentiment':'Тональность авторов',
    'mint_first_movers':'Первые авторы токенов', 'mint_timeline':'Хронология токенов',
    'early_signals':'Ранние сигналы', 'lead_authors':'Авторы ранних сигналов', 'author_retention':'Удержание авторов',
    'weighted_sentiment':'Взвешенная тональность', 'cross_mint_signals':'Сигналы между токенами',
    'mint_decay_scores':'Затухание интереса', 'mint_freshness':'Свежесть токенов',
    'sentiment_divergence':'Расхождение тональности', 'mint_anomalies':'Аномалии токенов',
    'suspicious_authors':'Подозрительные авторы',
}
for prefix in ('v_', 'mv_'):
    LABELS.update({prefix + name: title for name, title in VIEW_NAMES.items()})


def description(table):
    if table == 'graph_signal_history':
        return 'Сигналы за завершённые окна: score от 0 до 100, level — LOW, MEDIUM, HIGH или CRITICAL. payload содержит число твитов, авторов, связанных сущностей и составляющие оценки.'
    if table == 'graph_priority_events':
        return 'Сохранённые события графа: priority 2 — HIGH, 3 — CRITICAL. Уникальный ключ защищает от дублей. Внешняя отправка уведомлений для этих событий не подключена.'
    if table.startswith(('v_', 'mv_')):
        return 'Вычисленная сводка исходных данных. Представления нельзя редактировать; материализованные сводки обновляет планировщик.'
    if table in ('x_tasks', 'x_tasks_dlq', 'outbox'):
        return 'Очередь работы. pending — ожидает, claimed — выполняется, done — завершена, failed — ошибка. DLQ хранит задачи, исчерпавшие попытки.'
    if table in ('twitter_tweets', 'tweet_token_links', 'twitter_profiles'):
        return 'Исходные данные X. handle — имя автора, tweet_id — ID публикации, mint — адрес токена Solana. Связи показывают, какие твиты найдены по запросу токена.'
    if table.startswith(('x_', 'account_', 'session_', 'scrape_')) or table == 'proxies':
        return 'Состояние сбора и аккаунтов. Секреты входа скрыты. Изменения служебных данных могут повлиять на работающий коллектор.'
    return 'Результаты анализа или настройки коллектора. Наведите на заголовок столбца, чтобы увидеть его имя и тип в базе; карточка показывает полную запись.'

class Mutation(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict, max_length=200)
    key: dict[str, Any] = Field(default_factory=dict, max_length=20)
    version: str | None = Field(default=None, max_length=20)
    confirm: bool = False

@contextmanager
def connection():
    dsn = os.getenv('ADMIN_X_COLLECTOR_DSN', '').strip()
    if not dsn:
        raise HTTPException(503, 'Подключение X Collector не настроено: ADMIN_X_COLLECTOR_DSN')
    try:
        with psycopg.connect(dsn, connect_timeout=3, row_factory=dict_row) as db:
            db.execute("SET LOCAL statement_timeout = '8s'")
            anchors = db.execute("SELECT to_regclass('public.x_tasks') AS tasks, to_regclass('public.twitter_tweets') AS tweets").fetchone()
            if not anchors['tasks'] or not anchors['tweets']:
                raise HTTPException(503, 'Подключена база без таблиц X Collector')
            yield db
    except psycopg.IntegrityError as exc:
        raise HTTPException(409, 'Нарушено ограничение базы: проверьте обязательные поля, уникальность и связанные записи') from exc
    except psycopg.Error as exc:
        raise HTTPException(503, 'База коллектора недоступна или операция отклонена. Проверьте подключение и типы полей') from exc


def catalog(db):
    return db.execute("""SELECT c.relname AS name, c.relkind AS kind,
        GREATEST(c.reltuples, 0)::bigint AS estimated_rows
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') ORDER BY c.relname""").fetchall()


def metadata(db, table):
    entry = next((r for r in catalog(db) if r['name'] == table), None)
    if entry is None:
        raise HTTPException(404, 'Таблица не найдена')
    columns = db.execute("""SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
        NOT a.attnotnull AS nullable, pg_get_expr(d.adbin,d.adrelid) AS default,
        a.attidentity AS identity, a.attgenerated AS generated,
        EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=a.attrelid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS primary_key
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE n.nspname='public' AND c.relname=%s AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum""", (table,)).fetchall()
    for c in columns:
        c['sensitive'] = is_sensitive(c['name']) or c['type'] == 'bytea' or c['name'] in ('proxy_json', 'credentials')
    entry.update(columns=columns, label=LABELS.get(table, table), description=description(table), editable=entry['kind'] in ('r','p') and table != 'schema_migrations')
    return entry


def validate_mutation(meta, body, action):
    if not meta['editable']:
        raise HTTPException(403, 'Представления и история миграций доступны только для просмотра')
    if not body.confirm:
        raise HTTPException(422, 'Подтвердите изменение записи')
    fields = {c['name']: c for c in meta['columns']}
    if action != 'insert':
        keys = {c['name'] for c in meta['columns'] if c['primary_key']}
        if not keys or set(body.key) != keys or any(v is None for v in body.key.values()) or not body.version or not body.version.isdigit():
            raise HTTPException(422, 'Для изменения нужны полный первичный ключ и версия записи')
    for name in body.values:
        c = fields.get(name)
        if not c or c['sensitive'] or c['generated'] or c['identity'] == 'a' or (action == 'update' and c['primary_key']):
            raise HTTPException(422, 'Поле недоступно для редактирования: ' + name)
    return fields


def has_secrets(value):
    if isinstance(value, str):
        import json
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return False
    if isinstance(value, dict):
        return any(is_sensitive(str(k)) or has_secrets(v) for k,v in value.items())
    if isinstance(value, (list, tuple)):
        return any(has_secrets(v) for v in value)
    return False


def has_redaction(value):
    if isinstance(value, dict):
        return any(has_redaction(v) for v in value.values())
    if isinstance(value, (list, tuple)):
        return any(has_redaction(v) for v in value)
    return isinstance(value, str) and '••••••' in value


def adapt(value, column):
    return Jsonb(value) if value is not None and column['type'] in ('json', 'jsonb') else value


def build_x_collector_router():
    router = APIRouter(prefix='/api/x-collector', tags=['x-collector'], dependencies=[Depends(require_admin)])

    @router.get('/tables')
    def tables():
        with connection() as db:
            entries = catalog(db)
            return {'tables': [{**e, 'label': LABELS.get(e['name'], e['name'])} for e in entries]}

    @router.get('/tables/{table}')
    def rows(table: str, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0, le=10_000_000), search: str = Query('', max_length=200), sort: str = '', descending: bool = True, filter_column: str = '', filter_value: str = Query('', max_length=1000)):
        with connection() as db:
            meta = metadata(db, table)
            fields = {c['name']: c for c in meta['columns']}
            public = [c['name'] for c in meta['columns'] if not c['sensitive'] and c['type'] not in ('json', 'jsonb') and not c['name'].endswith('_json')]
            conditions, params = [], []
            if search and public:
                conditions.append(sql.SQL(' OR ').join(sql.SQL('{}::text ILIKE %s').format(sql.Identifier(c)) for c in public))
                params.extend(['%' + search + '%'] * len(public))
            if filter_column:
                if filter_column not in public:
                    raise HTTPException(422, 'Недоступное поле фильтра')
                conditions.append(sql.SQL('{}::text = %s').format(sql.Identifier(filter_column)))
                params.append(filter_value)
            where = sql.SQL(' WHERE ') + sql.SQL(' AND ').join(sql.SQL('({})').format(c) for c in conditions) if conditions else sql.SQL('')
            if sort and sort not in public:
                raise HTTPException(422, 'Недоступное поле сортировки')
            order_names = ([sort] if sort else []) + [c['name'] for c in meta['columns'] if c['primary_key'] and c['name'] != sort]
            order = sql.SQL(' ORDER BY ') + sql.SQL(', ').join(sql.SQL('{} {}').format(sql.Identifier(c), sql.SQL('DESC' if descending else 'ASC')) for c in order_names) if order_names else sql.SQL('')
            relation = sql.Identifier('public', table)
            total = db.execute(sql.SQL('SELECT count(*) AS n FROM {}').format(relation) + where, params).fetchone()['n']
            selection = sql.SQL('* , xmin::text AS "__version"') if meta['kind'] in ('r','p') else sql.SQL('*')
            result = db.execute(sql.SQL('SELECT {} FROM {}').format(selection, relation) + where + order + sql.SQL(' LIMIT %s OFFSET %s'), params + [limit, offset]).fetchall()
            masked = []
            for row in result:
                clean = {k: '••••••' if k in fields and fields[k]['sensitive'] else _mask_nested(v, show_sensitive=False) for k, v in row.items()}
                clean['__protected_fields'] = [k for k,v in row.items() if has_secrets(v)]
                masked.append(clean)
            return {'table': meta, 'rows': masked, 'total': total, 'limit': limit, 'offset': offset}

    def mutate(table, body, action, request, admin):
        try:
            with connection() as db:
                meta = metadata(db, table)
                fields = validate_mutation(meta, body, action)
                relation = sql.Identifier('public', table)
                if any(has_secrets(v) or has_redaction(v) for v in body.values.values()):
                    raise HTTPException(422, 'JSON с секретными полями или скрытыми значениями нельзя записать через редактор')
                params = [adapt(v, fields[k]) for k,v in body.values.items()]
                if action == 'insert':
                    query = sql.SQL('INSERT INTO {} ({}) VALUES ({})').format(relation, sql.SQL(',').join(map(sql.Identifier, body.values)), sql.SQL(',').join(sql.Placeholder() for _ in body.values)) if body.values else sql.SQL('INSERT INTO {} DEFAULT VALUES').format(relation)
                else:
                    predicate = sql.SQL(' AND ').join(sql.SQL('{} = %s').format(sql.Identifier(k)) for k in body.key) + sql.SQL(' AND xmin::text = %s')
                    key_params = [adapt(v, fields[k]) for k,v in body.key.items()] + [body.version]
                    if action == 'update':
                        current = db.execute(sql.SQL('SELECT * FROM {} WHERE {} FOR UPDATE').format(relation, predicate), key_params).fetchone()
                        if current is None:
                            raise HTTPException(409, 'Запись уже изменена или удалена. Обновите таблицу')
                        if any(has_secrets(current[k]) for k in body.values):
                            raise HTTPException(422, 'Поле содержит скрытые секреты и доступно только для чтения')
                    if action == 'delete':
                        query = sql.SQL('DELETE FROM {} WHERE {}').format(relation, predicate)
                        params = key_params
                    else:
                        if not body.values:
                            raise HTTPException(422, 'Нет изменённых полей')
                        query = sql.SQL('UPDATE {} SET {} WHERE {}').format(relation, sql.SQL(',').join(sql.SQL('{} = %s').format(sql.Identifier(k)) for k in body.values), predicate)
                        params += key_params
                cursor = db.execute(query, params)
                if cursor.rowcount != 1:
                    raise HTTPException(409, 'Запись уже изменена или удалена. Обновите таблицу')
            request.app.state.audit.record(action='x_collector_' + action, success=True, username=admin['sub'], resource=table, details={'fields': list(body.values), 'key_fields': list(body.key)})
            return {'ok': True}
        except HTTPException as exc:
            request.app.state.audit.record(action='x_collector_' + action, success=False, username=admin['sub'], resource=table, details={'status_code': exc.status_code})
            raise

    @router.post('/tables/{table}')
    def insert(table: str, body: Mutation, request: Request, admin=Depends(require_admin)):
        return mutate(table, body, 'insert', request, admin)

    @router.patch('/tables/{table}')
    def update(table: str, body: Mutation, request: Request, admin=Depends(require_admin)):
        return mutate(table, body, 'update', request, admin)

    @router.delete('/tables/{table}')
    def delete(table: str, body: Mutation, request: Request, admin=Depends(require_admin)):
        return mutate(table, body, 'delete', request, admin)

    return router
