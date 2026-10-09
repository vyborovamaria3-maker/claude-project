"""Typed controls for the preview agent; no X sessions or API keys are exposed."""
import time
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from .auth import require_admin
from .x_collector_admin import connection

class AgentLimits(BaseModel):
    per_cycle: int = Field(ge=1, le=10)
    per_day: int = Field(ge=1, le=100)
    version: str = Field(pattern=r'^\d+$')

class AgentControl(BaseModel):
    stopped: bool

class AccountRole(BaseModel):
    role: Literal['collector', 'publisher']
    version: str = Field(pattern=r'^\d+$')

class AgentCommand(BaseModel):
    kind: Literal['run', 'discover']

def ready(db):
    row = db.execute("SELECT to_regclass('public.social_agent_commands') AS commands").fetchone()
    if not row or not row['commands']:
        raise HTTPException(503, 'Выполните миграции X Collector до 014 включительно, затем запустите планировщик.')

def audit(request, admin, action, details):
    request.app.state.audit.record(action=action, success=True, username=admin['sub'], resource='social_agent', details=details)

def build_social_agent_router():
    router = APIRouter(prefix='/api/social-agent', tags=['social-agent'], dependencies=[Depends(require_admin)])

    @router.get('/state')
    def state(status: Literal['all', 'simulated', 'blocked'] = 'all', page: int = Query(1, ge=1, le=100000)):
        with connection() as db:
            ready(db)
            settings = db.execute('SELECT *, xmin::text AS version FROM social_agent_settings WHERE id=1').fetchone()
            if not settings:
                raise HTTPException(503, 'Настройки агента отсутствуют. Восстановите строку настроек id=1.')
            accounts = db.execute('SELECT name,role,status,tier,account_busy_until,xmin::text AS version FROM x_accounts ORDER BY role,name').fetchall()
            today = int(time.time() * 1000) // 86400000 * 86400000
            counts = db.execute("SELECT count(*) AS today, count(*) FILTER(WHERE status='simulated') AS simulated, count(*) FILTER(WHERE status='blocked') AS blocked FROM social_agent_actions WHERE created_at >= %s", (today,)).fetchone()
            total = db.execute("SELECT count(*) AS n FROM social_agent_actions WHERE (%s='all' OR status=%s)", (status,status)).fetchone()['n']
            actions = db.execute("SELECT id,account_name,kind,tweet_id,status,content,reason,evidence,provider,created_at FROM social_agent_actions WHERE (%s='all' OR status=%s) ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET %s", (status,status,(page-1)*20)).fetchall()
            commands = db.execute('SELECT id,kind,status,created_at,completed_at,result,error FROM social_agent_commands ORDER BY id DESC LIMIT 5').fetchall()
        return {'settings': settings, 'accounts': accounts, 'counts': counts, 'actions': actions, 'commands': commands, 'total': total, 'page': page, 'page_size': 20, 'mode': 'preview', 'provider': 'deterministic-preview'}

    @router.put('/control')
    def control(body: AgentControl, request: Request, admin=Depends(require_admin)):
        with connection() as db:
            ready(db)
            changed = db.execute('UPDATE social_agent_settings SET stopped=%s,updated_at=%s WHERE id=1', (body.stopped,int(time.time()*1000)))
            if changed.rowcount != 1:
                raise HTTPException(503, 'Настройки агента отсутствуют.')
        audit(request,admin,'social_agent_control',{'stopped':body.stopped})
        return {'ok': True}

    @router.put('/limits')
    def limits(body: AgentLimits, request: Request, admin=Depends(require_admin)):
        with connection() as db:
            ready(db)
            changed = db.execute('UPDATE social_agent_settings SET max_actions_per_cycle=%s,max_actions_per_day=%s,updated_at=%s WHERE id=1 AND xmin::text=%s', (body.per_cycle,body.per_day,int(time.time()*1000),body.version))
            if changed.rowcount != 1:
                raise HTTPException(409,'Настройки уже изменены. Обновите вкладку и повторите сохранение.')
        audit(request,admin,'social_agent_limits',{'per_cycle':body.per_cycle,'per_day':body.per_day})
        return {'ok':True}

    @router.put('/accounts/{name}/role')
    def account_role(name: str, body: AccountRole, request: Request, admin=Depends(require_admin)):
        with connection() as db:
            ready(db)
            changed = db.execute('UPDATE x_accounts SET role=%s,updated_at=%s WHERE name=%s AND xmin::text=%s AND COALESCE(account_busy_until,0)<=%s', (body.role,int(time.time()*1000),name,body.version,int(time.time()*1000)))
            if changed.rowcount != 1:
                raise HTTPException(409,'Аккаунт занят, изменён или удалён. Обновите вкладку и дождитесь завершения его задачи.')
        audit(request,admin,'social_agent_account_role',{'account':name,'role':body.role})
        return {'ok':True}

    @router.post('/commands', status_code=202)
    def command(body: AgentCommand, request: Request, admin=Depends(require_admin)):
        with connection() as db:
            ready(db)
            settings=db.execute('SELECT stopped FROM social_agent_settings WHERE id=1 FOR UPDATE').fetchone()
            if not settings or settings['stopped']:
                raise HTTPException(409,'Сначала включите тестовый режим агента.')
            row=db.execute("INSERT INTO social_agent_commands(kind,created_at) VALUES(%s,%s) ON CONFLICT(kind) WHERE status='pending' DO NOTHING RETURNING id", (body.kind,int(time.time()*1000))).fetchone()
            if not row:
                raise HTTPException(409,'Такая команда уже ожидает планировщик.')
        audit(request,admin,'social_agent_command',{'kind':body.kind,'id':row['id']})
        return {'id':row['id'],'status':'pending'}
    return router
