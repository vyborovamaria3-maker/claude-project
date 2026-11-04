"""Descriptive analysis only: no model calls, threshold fitting or independence claim."""
import math
import statistics
from collections import defaultdict


def ranks(values):
    result = [0.] * len(values)
    ordered = sorted(range(len(values)), key=values.__getitem__)
    start = 0
    while start < len(values):
        end = start + 1
        while end < len(values) and values[ordered[end]] == values[ordered[start]]:
            end += 1
        for index in ordered[start:end]:
            result[index] = (start + 1 + end) / 2
        start = end
    return result


def spearman(rows, field):
    if len(rows) < 3:
        return None
    x, y = ranks([r[field] for r in rows]), ranks([r['return_pct'] for r in rows])
    mx, my = statistics.mean(x), statistics.mean(y)
    numerator = sum((a-mx)*(b-my) for a, b in zip(x, y))
    denominator = math.sqrt(sum((a-mx)**2 for a in x)*sum((b-my)**2 for b in y))
    return numerator / denominator if denominator else None


def describe(rows):
    tokens = {r['mint'] for r in rows}
    return dict(n=len(rows), tokens=len(tokens),
        mean_return=statistics.mean(r['return_pct'] for r in rows) if rows else None,
        median_return=statistics.median(r['return_pct'] for r in rows) if rows else None,
        positive_pct=100*sum(r['return_pct'] > 0 for r in rows)/len(rows) if rows else None,
        pressure_rho=spearman(rows, 'pressure'), quality_rho=spearman(rows, 'quality'))


def cohort_analysis(rows):
    ordered = sorted(rows, key=lambda r: (r['signal_at'], r['snapshot_id']))
    representatives = {}
    for row in ordered:
        representatives.setdefault(row['mint'], row)
    per_token = list(representatives.values())
    sensitivity = {}
    for field in ('pressure', 'quality'):
        values = [spearman([r for r in rows if r['mint'] != mint], field)
                  for mint in representatives] if len(representatives) <= 100 else []
        values = [v for v in values if v is not None]
        sensitivity[field] = dict(min=min(values) if values else None, max=max(values) if values else None,
                                  defined=len(values), omitted=len(representatives)-len(values))
    bins = []
    for name, predicate in (
        ('Pressure < 10', lambda r: r['pressure'] < 10),
        ('Pressure 10–<20', lambda r: 10 <= r['pressure'] < 20),
        ('Pressure ≥ 20', lambda r: r['pressure'] >= 20),
        ('Quality < 70', lambda r: r['quality'] < 70),
        ('Quality ≥ 70', lambda r: r['quality'] >= 70),
    ):
        bins.append(dict(name=name, **describe([r for r in rows if predicate(r)])))
    groups = defaultdict(list)
    for row in rows:
        groups[(row['mint'], round(row['pressure'], 8), round(row['quality'], 8), round(row['coverage'], 8))].append(row)
    examples = []
    for group in groups.values():
        low, high = min(group, key=lambda r: r['return_pct']), max(group, key=lambda r: r['return_pct'])
        if low['return_pct'] < 0 < high['return_pct']:
            examples.append(dict(mint=low['mint'], spread=high['return_pct']-low['return_pct'], negative=low, positive=high))
    examples.sort(key=lambda e: (-e['spread'], e['mint']))
    return dict(all=describe(rows), one_per_token=describe(per_token), token_representatives=per_token,
        leave_one_token_out=sensitivity, bins=bins, examples=examples[:2],
        pressure_range=[min(r['pressure'] for r in rows), max(r['pressure'] for r in rows)] if rows else None,
        quality_levels=sorted({r['quality'] for r in rows}),
        coverage_range=[min(r['coverage'] for r in rows), max(r['coverage'] for r in rows)] if rows else None,
        zero_x_rows=sum(r['x_count'] == 0 for r in rows))


def analyze_score_rows(rows, total_available=None):
    valid = [r for r in rows if all(isinstance(r.get(k), (int, float))
             and not isinstance(r[k], bool) and math.isfinite(r[k])
             for k in ('pressure', 'quality', 'coverage', 'return_pct', 'drawdown_pct'))]
    valid.sort(key=lambda r: (r['completed_at'], r['snapshot_id']))
    initial = valid[:40]
    report = cohort_analysis(initial)
    report.update(status='predictive_link_not_established', initial_target=40,
        horizon_hours=1, timeframe='5m', score_version='fomo-pressure-quality-local-pg-v1',
        selection='first_40_completed_then_snapshot_id', initial_completed_cutoff=max((r['completed_at'] for r in initial), default=None),
        available=total_available if total_available is not None else len(rows),
        invalid_rows=len(rows)-len(valid), analysis_limit=5000,
        truncated=(total_available or len(rows)) > len(rows),
        current=cohort_analysis(valid),
        conclusions=[
            'Предсказательная связь FOMO с ростом цены пока не установлена. Корреляции ниже — описание этой выборки, а не проверенный торговый сигнал.',
            'Первый блок фиксирует первые 40 готовых часовых результатов по времени завершения, а не последние 40. Расширение показано отдельно. Отбор зависит от доступности цен; пропущенные результаты могут смещать оценку.',
            'Повторные 15-минутные снимки одного токена и перекрывающиеся часовые окна зависимы. Дополнительно показан самый ранний доступный результат каждого токена и исключение по одному токену; это не делает рынок независимым экспериментом.',
            'При покрытии Quality 7,5% остаётся только компонент распространения в Telegram; бот-риск и межплатформенное подтверждение не измерены. Балл Quality 76,88 не означает 76,88% вероятности роста.',
            'Интервалы групп заданы описательно, без подбора лучшего порога. Нет сравнения с рынком, контроля ликвидности, комиссий, проскальзывания и проверки на отдельном будущем периоде. p-value и точность прогноза не рассчитываются.',
        ])
    return report
