import { createRequire } from 'node:module';
export type CheckStep={status:'pending'|'running'|'passed'|'failed'|'skipped';message?:string};
export type CheckSteps=Record<'database'|'session'|'proxy'|'browser'|'x',CheckStep>;
export const computeScore:(steps:CheckSteps,hasProxy:boolean)=>{score:number;ready:boolean}=createRequire(__filename)('../../scripts/account-health.cjs').computeScore;
