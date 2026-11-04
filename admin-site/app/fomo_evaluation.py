"""Bounded, read-only projection of the local FOMO evaluation database."""
import json
import os
import sqlite3
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from .auth import require_admin
from .fomo_score_analysis import analyze_score_rows


def token_check_report():
    path = os.environ.get('ADMIN_TOKEN_CHECK_REPORT')
    if not path:
        return None
    try:
        if Path(path).stat().st_size > 65536:
            return None
        result = json.loads(Path(path).read_text(encoding='utf8'))
        return result if result.get('version') == 'multisource-token-check-v1' else None
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def connect_evaluation(path):
    if not path or not Path(path).is_file():
        raise HTTPException(503, 'База снимков FOMO не подключена')
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, timeout=3)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    return db


def evaluation_report(path, now=None):
    now = int(time.time() * 1000) if now is None else now
    db = connect_evaluation(path)
    try:
        summary = dict(db.execute('''SELECT count(*) snapshots,count(DISTINCT mint) tokens,
            min(signal_at) first_at,max(signal_at) latest_at,
            count(*) FILTER(WHERE signal_at>=?) added_hour,
            count(*) FILTER(WHERE signal_at>=?) added_15m FROM fomo_score_snapshots''',
            (now-3600000, now-900000)).fetchone())
        worker = db.execute('''SELECT last_tick_at,last_capture_at,last_outcome_at,
            next_capture_at,next_outcome_at,last_error FROM fomo_local_worker WHERE id=1''').fetchone()
        horizons = []
        for horizon in (1, 6, 24):
            result = dict(db.execute('''SELECT count(*) labelled,count(DISTINCT s.mint) tokens
                FROM fomo_price_outcomes o JOIN fomo_score_snapshots s USING(snapshot_id)
                WHERE o.horizon_hours=? AND o.timeframe='5m' ''', (horizon,)).fetchone())
            result.update(horizon_hours=horizon, immature=db.execute(
                'SELECT count(*) FROM fomo_score_snapshots WHERE signal_at>?', (now-horizon*3600000,)).fetchone()[0])
            horizons.append(result)
        snapshots = [dict(row) for row in db.execute('''SELECT snapshot_id,mint,signal_at,score_version,
            fomo_pressure,fomo_quality,quality_coverage,x_sample_count,tg_sample_count
            FROM fomo_score_snapshots ORDER BY signal_at DESC,snapshot_id LIMIT 50''')]
        outcomes = []
        for row in db.execute('''SELECT o.snapshot_id,o.horizon_hours,o.completed_at,o.evidence_sha256,
            s.mint,s.signal_at,s.fomo_pressure,s.fomo_quality,s.quality_coverage,o.labelled_json
            FROM fomo_price_outcomes o JOIN fomo_score_snapshots s USING(snapshot_id)
            ORDER BY o.completed_at DESC,o.snapshot_id LIMIT 50'''):
            item = dict(row)
            label = json.loads(item.pop('labelled_json'))
            item.update({key: label.get(key) for key in ('forwardReturnPct', 'maxDrawdownPct', 'outcomeAt')})
            outcomes.append(item)
        reasons = [dict(row) for row in db.execute('''SELECT horizon_hours,status,reason,count(*) n
            FROM fomo_price_attempts WHERE status<>'labelled'
            GROUP BY horizon_hours,status,reason ORDER BY horizon_hours,status,reason''')]
        latest = db.execute('SELECT source_meta_json FROM fomo_score_snapshots ORDER BY signal_at DESC LIMIT 1').fetchone()
        sources = json.loads(latest[0]).get('provenance', {}).get('corpusStatus', {}) if latest else {}
        analysis_filter = """FROM fomo_price_outcomes o JOIN fomo_score_snapshots s USING(snapshot_id)
            WHERE o.horizon_hours=1 AND o.timeframe='5m'
            AND s.score_version='fomo-pressure-quality-local-pg-v1'
            AND s.snapshot_sha256=o.snapshot_sha256 AND s.signal_at<=? AND o.completed_at<=?"""
        parameters = (now-3600000, now)
        analysis_rows = [dict(row) for row in db.execute('''SELECT o.snapshot_id,s.mint,s.signal_at,o.completed_at,
            s.fomo_pressure pressure,s.fomo_quality quality,s.quality_coverage coverage,
            s.x_sample_count x_count,s.tg_sample_count tg_count,
            json_extract(o.labelled_json,'$.forwardReturnPct') return_pct,
            json_extract(o.labelled_json,'$.maxDrawdownPct') drawdown_pct
            ''' + analysis_filter + ' ORDER BY o.completed_at,o.snapshot_id LIMIT 5000', parameters)]
        available = db.execute('SELECT count(*) ' + analysis_filter, parameters).fetchone()[0]
        analysis = analyze_score_rows(analysis_rows, total_available=available)
        return dict(checked_at=now, summary=summary, worker=dict(worker) if worker else None,
            worker_stale=not worker or not worker['last_tick_at'] or now-worker['last_tick_at']>300000,
            horizons=horizons, snapshots=snapshots, outcomes=outcomes, reasons=reasons, sources=sources, analysis=analysis, token_check=token_check_report())
    except (sqlite3.Error, ValueError, TypeError, KeyError):
        raise HTTPException(503, 'Данные оценки FOMO временно недоступны') from None
    finally:
        db.close()


def evaluation_evidence(path, snapshot_id, horizon):
    db = connect_evaluation(path)
    try:
        row = db.execute('''SELECT o.snapshot_sha256,o.evidence_sha256,o.labelled_json,e.payload_json,
            s.snapshot_sha256 current_hash FROM fomo_price_outcomes o
            JOIN fomo_price_evidence e ON e.sha256=o.evidence_sha256
            JOIN fomo_score_snapshots s USING(snapshot_id)
            WHERE o.snapshot_id=? AND o.horizon_hours=? AND o.timeframe='5m' ''', (snapshot_id, horizon)).fetchone()
        if not row:
            raise HTTPException(404, 'Сопоставление ещё не готово')
        if row['snapshot_sha256'] != row['current_hash']:
            raise HTTPException(409, 'Снимок изменён после расчёта')
        label, evidence = json.loads(row['labelled_json']), json.loads(row['payload_json'])
        return dict(snapshot_id=snapshot_id, snapshot_sha256=row['snapshot_sha256'],
            evidence_sha256=row['evidence_sha256'], signal_at=label['signalAt'],
            outcome_at=label['outcomeAt'], forward_return_pct=label['forwardReturnPct'],
            max_drawdown_pct=label['maxDrawdownPct'], method=label.get('outcomeMethod'),
            source=evidence.get('source'), unit=evidence.get('priceUnit'),
            fetched_at=evidence.get('fetchedAt'), pool=evidence.get('poolAddress'),
            request_url=evidence.get('requestUrl'), provenance=evidence.get('priceProvenance'),
            candles=evidence.get('candles', [])[:1000])
    except (sqlite3.Error, ValueError, TypeError, KeyError):
        raise HTTPException(503, 'Ценовое доказательство временно недоступно') from None
    finally:
        db.close()


def build_fomo_evaluation_router():
    router = APIRouter(prefix='/api/fomo-evaluation', dependencies=[Depends(require_admin)])

    @router.get('')
    def report(response: Response):
        response.headers['Cache-Control'] = 'private, no-store'
        return evaluation_report(os.environ.get('ADMIN_FOMO_EVALUATION_DB'))

    @router.get('/token-wallet-relations')
    def wallet_relations(response: Response):
        response.headers['Cache-Control'] = 'private, no-store'
        path = os.environ.get('ADMIN_TOKEN_WALLET_RELATIONS_REPORT')
        current = token_check_report() or {}
        expected = current.get('chainAssessment', {}).get('datasetHash')
        try:
            if not path or Path(path).stat().st_size > 2 * 1024 * 1024:
                raise HTTPException(503, 'Отчёт связей недоступен')
            report = json.loads(Path(path).read_text(encoding='utf8'))
        except (OSError, ValueError):
            raise HTTPException(503, 'Отчёт связей недоступен') from None
        if report.get('version') != 'wallet-relations-v1' or report.get('datasetHash') != expected or report.get('mint') != current.get('mint'):
            raise HTTPException(409, 'Снимок сделок изменился; связи нужно пересчитать')
        return report

    @router.get('/token-chain-evidence')
    def stored_chain_evidence():
        import hashlib
        report = token_check_report() or {}
        expected = report.get('chainAssessment', {}).get('datasetHash')
        path = os.environ.get('ADMIN_TOKEN_CHAIN_EVIDENCE')
        if not path or not expected:
            raise HTTPException(503, 'Снимок всех сделок ещё не сохранён')
        try:
            if Path(path).stat().st_size > 64 * 1024 * 1024:
                raise HTTPException(503, 'Снимок превышает предел скачивания')
            data = Path(path).read_bytes()
        except OSError:
            raise HTTPException(503, 'Снимок недоступен') from None
        if hashlib.sha256(data).hexdigest() != expected:
            raise HTTPException(409, 'Контрольный хеш снимка не совпал')
        return Response(data, media_type='application/x-ndjson', headers={
            'Cache-Control': 'private, no-store',
            'Content-Disposition': 'attachment; filename="stored-chain-evidence.jsonl"',
            'X-Content-SHA256': expected,
        })

    @router.get('/{snapshot_id}/evidence')
    def evidence(snapshot_id: str, response: Response, horizon: int = Query(1, ge=1, le=24)):
        if horizon not in (1, 6, 24) or len(snapshot_id) > 80:
            raise HTTPException(400, 'Некорректный снимок или горизонт')
        response.headers['Cache-Control'] = 'private, no-store'
        return evaluation_evidence(os.environ.get('ADMIN_FOMO_EVALUATION_DB'), snapshot_id, horizon)

    return router
