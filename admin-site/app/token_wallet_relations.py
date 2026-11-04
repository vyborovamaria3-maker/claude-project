"""Reproducible observations over an immutable stored-trade archive; no RPC/AI."""
import hashlib
import itertools
import json
import math
import random
import statistics
from collections import Counter, defaultdict

VERSION = 'wallet-relations-v1'


def episodes(slots, by_slot, gap=30):
    result = []
    for slot in sorted(slots, key=lambda s: (by_slot[s][0]['timestamp'], s)):
        stamp = by_slot[slot][0]['timestamp']
        if not result or stamp - result[-1]['lastAt'] > gap:
            result.append(dict(firstAt=stamp, lastAt=stamp, slots=[]))
        result[-1]['lastAt'] = stamp
        result[-1]['slots'].append(slot)
    return result


def slot_map(rows, side):
    slots = defaultdict(list)
    for row in rows:
        if row['side'] == side and row['amountSol'] > 0 and row['slot'] > 0:
            slots[row['slot']].append(row)
    return slots


def pair_support(by_slot):
    pairs = defaultdict(list)
    for slot, rows in by_slot.items():
        for pair in itertools.combinations(sorted({r['wallet'] for r in rows}), 2):
            pairs[pair].append(slot)
    return pairs


def analyze_records(rows, mint, digest, permutations=100):
    if len(rows) > 5000 or len({r['signature'] for r in rows}) != len(rows):
        raise ValueError('invalid_or_oversized_trade_snapshot')
    buys = slot_map(rows, 'buy')
    sells = slot_map(rows, 'sell')
    # A slot has one block timestamp. Conflicting stored timestamps are not proof.
    conflicts = {s for s, rs in buys.items() if len({r['timestamp'] for r in rs}) != 1}
    broad = {s for s, rs in buys.items() if len({r['wallet'] for r in rs}) > 20}
    eligible = {s: rs for s, rs in buys.items() if s not in conflicts | broad}
    supports = pair_support(eligible)
    wallet_slots = defaultdict(set)
    for slot, rs in eligible.items():
        for row in rs:
            wallet_slots[row['wallet']].add(slot)
    graph = []
    for (a, b), slots in supports.items():
        bursts = episodes(slots, eligible)
        if len(slots) >= 3 and len(bursts) >= 2:
            graph.append(dict(a=a, b=b, slots=len(slots), episodes=len(bursts),
                jaccard=len(slots)/len(wallet_slots[a] | wallet_slots[b]),
                slotIds=sorted(slots)))
    graph.sort(key=lambda p: (-p['slots'], -p['jaccard'], p['a'], p['b']))

    candidates = defaultdict(set)
    scanned = 0
    limited = False
    for slot, rs in sorted(eligible.items()):
        ws = sorted({r['wallet'] for r in rs})
        for size in range(3, min(8, len(ws))+1):
            for group in itertools.combinations(ws, size):
                scanned += 1
                if scanned > 200000:
                    limited = True
                    break
                candidates[group].add(slot)
            if limited:
                break
        if limited:
            break
    frequent = [(ws, slots) for ws, slots in candidates.items()
                if len(slots) >= 3 and len(episodes(slots, eligible)) >= 2]
    if len(frequent) > 2000:
        raise ValueError('frequent_candidate_budget_exceeded')
    # Closed itemsets remove subsets with exactly the same supporting slots.
    closed = [(ws, slots) for ws, slots in frequent if not any(
        set(ws) < set(other) and slots == other_slots for other, other_slots in frequent)]
    closed.sort(key=lambda g: (-len(g[0])*len(g[1]), -len(g[0]), g[0]))
    groups = []
    for index, (ws, slots) in enumerate(closed[:5]):
        members = set(ws)
        exit_slots = [s for s, rs in sells.items()
                      if len({r['timestamp'] for r in rs}) == 1 and members <= {r['wallet'] for r in rs}]
        activity = [r for r in rows if r['wallet'] in members and r['amountSol'] > 0]
        groups.append(dict(id='repeat-'+str(index+1), wallets=list(ws), sharedBuySlots=sorted(slots),
            episodes=episodes(slots, eligible), sharedSellSlots=sorted(exit_slots),
            buySlotIntersectionOverUnion=len(slots)/len(set().union(*(wallet_slots[w] for w in ws))),
            buySol=sum(r['amountSol'] for r in activity if r['side'] == 'buy'),
            sellSol=sum(r['amountSol'] for r in activity if r['side'] == 'sell'),
            buyEvidence=[r for s in sorted(slots) for r in eligible[s] if r['wallet'] in members],
            sellEvidence=[r for s in sorted(exit_slots) for r in sells[s] if r['wallet'] in members]))

    similar = []
    for slot, rs in eligible.items():
        ordered = sorted(rs, key=lambda r: (r['amountSol'], r['wallet'], r['signature']))
        best = []
        for i, first in enumerate(ordered):
            window = {}
            for row in ordered[i:]:
                if row['amountSol']/first['amountSol'] > 1.05 + 1e-12:
                    break
                window.setdefault(row['wallet'], row)
            if len(window) > len(best):
                best = list(window.values())
        if len(best) >= 3:
            similar.append(dict(slot=slot, wallets=len(best), minSol=min(r['amountSol'] for r in best),
                maxSol=max(r['amountSol'] for r in best), evidence=best))
    similar.sort(key=lambda g: (-g['wallets'], g['slot']))

    by_wallet = defaultdict(list)
    for row in rows:
        if row['side'] in ('buy', 'sell') and row['amountSol'] > 0:
            by_wallet[row['wallet']].append(row)
    rapid = []
    for wallet, rs in by_wallet.items():
        rs.sort(key=lambda r: (r['timestamp'], r['slot'], r['signature']))
        transitions = []
        for a, b in zip(rs, rs[1:]):
            ordered = b['slot'] > a['slot'] if a['slot'] and b['slot'] else b['timestamp'] > a['timestamp']
            if a['side'] == 'buy' and b['side'] == 'sell' and ordered and 0 <= b['timestamp']-a['timestamp'] < 60:
                transitions.append(dict(seconds=b['timestamp']-a['timestamp'], buy=a, sell=b))
        if len(transitions) >= 3:
            rapid.append(dict(wallet=wallet, transitions=len(transitions), examples=transitions[:3]))
    rapid.sort(key=lambda r: (-r['transitions'], r['wallet']))

    # Descriptive global-max control, not a fraud probability or a p-value.
    base = [(r['timestamp'], r['slot'], r['wallet']) for rs in eligible.values() for r in rs]
    minute_bins = defaultdict(list)
    for i, (stamp, _, _) in enumerate(base):
        minute_bins[stamp//60].append(i)
    rng = random.Random(int(digest[:16], 16))
    maxima = []
    for _ in range(permutations):
        shuffled = list(base)
        for indexes in minute_bins.values():
            labels = [base[i][2] for i in indexes]
            rng.shuffle(labels)
            for i, wallet in zip(indexes, labels):
                shuffled[i] = (base[i][0], base[i][1], wallet)
        shuffled_slots = defaultdict(set)
        for _, slot, wallet in shuffled:
            shuffled_slots[slot].add(wallet)
        counts = Counter()
        for ws in shuffled_slots.values():
            counts.update(itertools.combinations(sorted(ws), 2))
        maxima.append(max(counts.values(), default=0))
    control = dict(repeats=permutations, observedMaxPairSlots=max(map(len, supports.values()), default=0),
        shuffledMedian=statistics.median(maxima) if maxima else None,
        shuffledMin=min(maxima) if maxima else None, shuffledMax=max(maxima) if maxima else None,
        method='wallet labels shuffled within UTC minute; row counts preserved; global maximum over all pairs',
        limitation='Описательный контроль зависит от выбранной модели перемешивания; это не вероятность мошенничества и не доказательство владельца.')
    summary = dict(records=len(rows), wallets=len({r['wallet'] for r in rows}),
        zeroSolBuys=sum(r['side'] == 'buy' and r['amountSol'] == 0 for r in rows),
        zeroSolSells=sum(r['side'] == 'sell' and r['amountSol'] == 0 for r in rows),
        positiveBuys=sum(r['side'] == 'buy' and r['amountSol'] > 0 for r in rows),
        sameSlotGroups=sum(len({r['wallet'] for r in rs}) >= 2 for rs in eligible.values()),
        repeatedGroups=len(closed), strongTemporalEdges=len(graph),
        similarAmountGroups=len(similar), rapidWallets=len(rapid),
        conflictingSlots=len(conflicts), broadSlotsSkipped=len(broad), candidateSearchLimited=limited)
    return dict(version=VERSION, mint=mint, datasetHash=digest, summary=summary,
        policy=dict(amount='strictly positive recorded SOL', slot='same positive slot; consistent timestamp',
            repeat='3+ shared slots;2+ temporal episodes', episodeGapSeconds=30,
            itemsets='closed sets3..8wallets; slots with>20wallets excluded;200000candidate cap',
            similarAmounts='3+ distinct wallets; same slot;max/min<=1.05',
            rapid='adjacent positive BUY→SELL;<60s;same-slot order excluded'),
        groups=groups, pairs=graph[:50], similarAmountExamples=similar[:5], rapidExamples=rapid[:5],
        control=control, limitations=[
            'Совпадение слота и повторяемость — наблюдения в сохранённых данных, а не подтверждение Jito-бандла, общего владельца или накрутки.',
            'Нулевой SOL может означать неполные сведения о расчёте; это не доказательство бесплатной сделки. Такие строки исключены из сравнения сумм.',
            'Эпизоды разделены паузой более30с; они не объявляются статистически независимыми.',
            'Общее финансирование и переводы между участниками не подтверждены; новых RPC-запросов нет. Полнота и исполнение источника не подтверждены.',
            'BUY→SELL рядом по времени не является расчётом закрытой позиции или PNL. Суммы BUY/SELL не доказывают прибыльность.',
        ])


def analyze_archive(data, expected_hash, permutations=100):
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected_hash:
        raise ValueError('source_archive_hash_mismatch')
    lines = data.decode('utf8').splitlines()
    header = json.loads(lines[0])
    if len(header) != 2 or header[0] != 'stored-chain-v1':
        raise ValueError('invalid_archive_header')
    rows = []
    for line, text in enumerate(lines[1:], 2):
        raw = json.loads(text)
        if len(raw) != 9 or not isinstance(raw[4], (float, int)) or not math.isfinite(raw[4]) or raw[4] < 0:
            raise ValueError('invalid_trade_record')
        rows.append(dict(signature=raw[0], timestamp=raw[1], wallet=raw[2], side=raw[3],
            amountSol=raw[4], amountTokens=raw[5], slot=raw[7] or 0, archiveLine=line))
    return analyze_records(rows, header[1], digest, permutations)
