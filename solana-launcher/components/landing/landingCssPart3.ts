// Auto-generated from approved POTAPoff landing CSS.
export const LANDING_CSS_PART_3 = String.raw`  0%{transform:translateX(-120%) rotate(8deg)}
  55%,100%{transform:translateX(120%) rotate(8deg)}
}
@keyframes loginScan{
  0%{left:-120%}
  100%{left:140%}
}
@keyframes loginCtaPulse{
  0%,100%{box-shadow:0 20px 50px -24px rgba(139,92,246,.45), 0 14px 35px -22px rgba(124,255,107,.5)}
  50%{box-shadow:0 24px 65px -18px rgba(139,92,246,.55), 0 18px 45px -18px rgba(124,255,107,.68)}
}

@media(max-width:600px){
  .modal{align-items:end;padding:10px}
  .login-card{width:100%;border-radius:24px}
  .login-card::before{border-radius:24px}
  .login-panel{padding:20px;border-radius:24px}
  .login-panel h3{font-size:28px}
}
@media (prefers-reduced-motion:reduce){
  .login-card::before,.login-card::after,.login-panel,.login-panel::before,.login-btn,.login-btn::before,.telegram-auth::before{animation:none!important}
}



/* Social Intelligence section */
.social-intel{
  position:relative;
  overflow:hidden;
  padding:110px 0;
  border-block:1px solid rgba(255,255,255,.06);
  background:
    radial-gradient(circle at 15% 50%, rgba(56,189,248,.08), transparent 28rem),
    radial-gradient(circle at 86% 38%, rgba(139,92,246,.10), transparent 30rem),
    rgba(7,10,16,.72);
}
.social-intel::before{
  content:"";
  position:absolute;inset:0;pointer-events:none;
  background-image:
    linear-gradient(rgba(255,255,255,.022) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.022) 1px, transparent 1px);
  background-size:52px 52px;
  mask-image:linear-gradient(90deg,transparent,black 20%,black 80%,transparent);
}
.social-wrap{
  position:relative;
  display:grid;
  grid-template-columns:.88fr 1.12fr;
  gap:54px;
  align-items:center;
}
.social-copy{max-width:560px}
.social-kicker{
  display:inline-flex;align-items:center;gap:9px;
  color:#77dcff;font-size:10px;font-weight:850;letter-spacing:.17em;text-transform:uppercase;
}
.social-kicker i{
  width:7px;height:7px;border-radius:50%;
  background:#38bdf8;box-shadow:0 0 12px #38bdf8;
}
.social-copy h2{
  margin:16px 0 0;
  font-size:clamp(38px,4.9vw,64px);
  line-height:.98;
  letter-spacing:-.052em;
}
.social-copy h2 span{
  display:block;
  background:linear-gradient(95deg,#fff 5%,#a58bff 48%,#74ff6f 94%);
  color:transparent;background-clip:text;-webkit-background-clip:text;
}
.social-copy>p{
  margin:19px 0 0;
  color:#8d99aa;
  font-size:15px;
  line-height:1.72;
}
.social-quote{
  margin-top:24px;
  padding:16px 18px;
  border-left:1px solid rgba(124,255,107,.35);
  background:linear-gradient(90deg,rgba(124,255,107,.06),transparent);
  color:rgba(255,255,255,.72);
  font-size:13px;
  line-height:1.65;
}
.social-tags{
  display:flex;flex-wrap:wrap;gap:8px;margin-top:22px
}
.social-tags span{
  padding:7px 10px;border:1px solid rgba(255,255,255,.07);
  border-radius:999px;background:rgba(255,255,255,.02);
  color:#687589;font-size:8px;letter-spacing:.10em
}
.social-engine{
  position:relative;
  min-height:470px;
  padding:22px;
  border:1px solid rgba(255,255,255,.09);
  border-radius:28px;
  background:
    radial-gradient(circle at 88% 8%, rgba(139,92,246,.13), transparent 28%),
    radial-gradient(circle at 10% 90%, rgba(56,189,248,.10), transparent 30%),
    linear-gradient(180deg,rgba(13,19,29,.94),rgba(8,12,18,.98));
  box-shadow:0 38px 100px -60px #000;
  overflow:hidden;
}
.social-engine::after{
  content:"";
  position:absolute;inset:-25%;
  background:linear-gradient(110deg,transparent 40%,rgba(255,255,255,.035) 50%,transparent 60%);
  transform:translateX(-120%);
  animation:socialSweep 7s ease-in-out infinite;
  pointer-events:none;
}
.social-head{
  position:relative;z-index:1;
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding-bottom:15px;border-bottom:1px solid rgba(255,255,255,.06)
}
.social-brand-pair{display:flex;align-items:center;gap:9px}
.social-app{
  width:38px;height:38px;display:grid;place-items:center;
  border-radius:12px;border:1px solid rgba(255,255,255,.09);
  background:rgba(255,255,255,.03);font-weight:900;font-size:12px
}
.social-app.tg{color:#73d7ff;background:rgba(56,189,248,.08)}
.social-app.x{color:#fff;background:rgba(255,255,255,.04)}
.social-head strong{font-size:12px}
.social-head small{display:block;margin-top:3px;color:#596579;font-size:8px}
.signal-status{
  display:flex;align-items:center;gap:6px;
  color:#7cff6b;font-size:8px;font-weight:850;letter-spacing:.12em
}
.signal-status i{width:6px;height:6px;border-radius:50%;background:#7cff6b;box-shadow:0 0 9px #7cff6b;animation:pulse 1.6s infinite}
.signal-grid{
  position:relative;z-index:1;
  display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px
}
.signal-card{
  padding:14px;border:1px solid rgba(255,255,255,.07);border-radius:14px;
  background:rgba(255,255,255,.022)
}
.signal-card small{
  display:block;color:#5f6b7e;font-size:7px;letter-spacing:.11em;text-transform:uppercase
}
.signal-card strong{
  display:block;margin-top:7px;font-size:16px;letter-spacing:-.02em
}
.signal-card strong.good{color:#7cff6b}
.signal-card strong.blue{color:#6cd7ff}
.signal-card strong.purple{color:#b79aff}
.social-flow{
  position:relative;z-index:1;margin-top:11px;
  padding:14px;border:1px solid rgba(255,255,255,.07);border-radius:14px;
  background:rgba(255,255,255,.018)
}
.flow-title{
  display:flex;align-items:center;justify-content:space-between;gap:10px
}
.flow-title small{color:#5d697b;font-size:7px;letter-spacing:.11em}
.flow-title b{color:#7cff6b;font-size:8px}
.flow-chart{
  height:120px;margin-top:10px;position:relative;overflow:hidden;border-radius:10px;
  background:
    linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);
  background-size:100% 33%,20% 100%;
}
.flow-line{
  position:absolute;left:4%;right:4%;top:48%;height:2px;
  background:linear-gradient(90deg,#38bdf8 0%,#8b5cf6 48%,#7cff6b 100%);
  box-shadow:0 0 16px rgba(124,255,107,.22);
  transform:skewY(-4deg);
}
.flow-line::before,.flow-line::after{
  content:"";position:absolute;width:8px;height:8px;border-radius:50%;top:-3px
}
.flow-line::before{left:23%;background:#38bdf8;box-shadow:0 0 12px #38bdf8}
.flow-line::after{right:16%;background:#7cff6b;box-shadow:0 0 12px #7cff6b}
.social-verdict{
  position:relative;z-index:1;
  margin-top:11px;padding:13px 14px;
  display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:11px;
  border:1px solid rgba(124,255,107,.18);border-radius:14px;
  background:linear-gradient(90deg,rgba(124,255,107,.08),rgba(139,92,246,.04))
}
.social-verdict>span{
  width:38px;height:38px;display:grid;place-items:center;border-radius:12px;
  background:rgba(124,255,107,.10);color:#7cff6b;font-size:17px
}
.social-verdict strong{display:block;font-size:12px}
.social-verdict small{display:block;margin-top:3px;color:#687589;font-size:8px}
.social-score{color:#7cff6b;font-size:18px;font-weight:900}
@keyframes socialSweep{
  0%{transform:translateX(-120%) rotate(6deg)}
  55%,100%{transform:translateX(120%) rotate(6deg)}
}
@media(max-width:980px){
  .social-wrap{grid-template-columns:1fr;gap:34px}
}
@media(max-width:600px){
  .social-intel{padding:82px 0}
  .social-engine{padding:16px;border-radius:22px;min-height:auto}
  .signal-grid{grid-template-columns:1fr}
  .social-verdict{grid-template-columns:auto 1fr}
  .social-score{grid-column:2}
}



/* Intelligence pipeline */
.pipeline-section{
  position:relative;
  padding:96px 0 108px;
}
.pipeline-head{
  display:flex;align-items:end;justify-content:space-between;gap:32px;margin-bottom:34px;
}
.pipeline-head>div:first-child{max-width:760px}
.pipeline-head h2{
  margin:14px 0 0;
  font-size:clamp(36px,4.7vw,58px);
  line-height:1.01;
  letter-spacing:-.05em;
}
.pipeline-head p{
  max-width:470px;margin:0;color:#7f8c9f;font-size:13px;line-height:1.65;
}
.pipeline{
  position:relative;
  display:grid;grid-template-columns:repeat(4,1fr);gap:12px;
}
.pipeline::before{
  content:"";
  position:absolute;left:8%;right:8%;top:41px;height:1px;
  background:linear-gradient(90deg,rgba(56,189,248,.25),rgba(139,92,246,.35),rgba(124,255,107,.32));
  box-shadow:0 0 18px rgba(124,255,107,.08);
}
.pipe-card{
  position:relative;min-height:245px;padding:22px;
  border:1px solid rgba(255,255,255,.07);border-radius:20px;
  background:linear-gradient(180deg,rgba(255,255,255,.028),rgba(255,255,255,.012));
  overflow:hidden;
}
.pipe-card::after{
  content:"";position:absolute;width:150px;height:150px;border-radius:50%;
  right:-80px;bottom:-80px;background:rgba(124,255,107,.05);filter:blur(22px)
}
.pipe-node{
  position:relative;z-index:2;
  width:38px;height:38px;display:grid;place-items:center;border-radius:50%;
  border:1px solid rgba(255,255,255,.12);background:#0b1119;
  color:#9aa7b9;font-size:9px;font-weight:900;letter-spacing:.08em;
}
.pipe-card:nth-child(1) .pipe-node{color:#75d9ff;border-color:rgba(56,189,248,.28)}
.pipe-card:nth-child(2) .pipe-node{color:#b69cff;border-color:rgba(139,92,246,.30)}
.pipe-card:nth-child(3) .pipe-node{color:#9dff8d;border-color:rgba(124,255,107,.28)}
.pipe-card:nth-child(4) .pipe-node{color:#fff;border-color:rgba(255,255,255,.22)}
.pipe-card h3{position:relative;z-index:1;margin:30px 0 0;font-size:18px}
.pipe-card p{position:relative;z-index:1;margin:9px 0 0;color:#778598;font-size:12px;line-height:1.62}
.pipe-tag{
  position:absolute;left:22px;bottom:18px;color:#4f5b6d;font-size:7px;letter-spacing:.11em
}
@media(max-width:980px){
  .pipeline-head{align-items:flex-start;flex-direction:column}
  .pipeline{grid-template-columns:repeat(2,1fr)}
  .pipeline::before{display:none}
}
@media(max-width:600px){
  .pipeline{grid-template-columns:1fr}
  .pipe-card{min-height:220px}
}



/* --- signature visuals instead of plain icons --- */
.strip-item{
  position:relative;
}
.strip-visual{
  width:48px;height:48px;flex:0 0 auto;
  display:grid;place-items:center;
  border:1px solid rgba(255,255,255,.08);
  border-radius:14px;
  background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.015));
  overflow:hidden;
  position:relative;
}
.strip-visual::after{
  content:"";position:absolute;inset:-30%;
  background:linear-gradient(120deg,transparent 35%,rgba(255,255,255,.05) 50%,transparent 65%);
  transform:translateX(-120%);
  animation:signatureSweep 6s ease-in-out infinite;
}
.sv-signal .bar{
  position:absolute;bottom:11px;width:4px;border-radius:8px;background:#38bdf8;
  box-shadow:0 0 10px rgba(56,189,248,.35);
}
.sv-signal .bar:nth-child(1){left:12px;height:10px;animation:barPulse 1.8s infinite}
.sv-signal .bar:nth-child(2){left:20px;height:18px;animation:barPulse 1.8s .2s infinite}
.sv-signal .bar:nth-child(3){left:28px;height:26px;background:#8b5cf6;animation:barPulse 1.8s .4s infinite}
.sv-signal .bar:nth-child(4){left:36px;height:16px;background:#7cff6b;animation:barPulse 1.8s .6s infinite}

.sv-verify .ring{
  width:24px;height:24px;border-radius:50%;
  border:1px solid rgba(124,255,107,.35);
  position:absolute;animation:ringPulse 2.4s ease-in-out infinite;
}
.sv-verify .ring.r2{width:12px;height:12px;border-color:rgba(56,189,248,.45);animation-delay:.4s}
.sv-verify .dot{
  position:absolute;width:6px;height:6px;border-radius:50%;background:#7cff6b;
  box-shadow:0 0 10px #7cff6b;
}
.sv-verify .dot.d1{left:12px;top:12px}
.sv-verify .dot.d2{right:12px;top:18px;background:#38bdf8;box-shadow:0 0 10px #38bdf8}
.sv-verify .dot.d3{left:22px;bottom:11px;background:#8b5cf6;box-shadow:0 0 10px #8b5cf6}

.sv-action .path{
  position:absolute;left:10px;right:10px;top:24px;height:2px;
  background:linear-gradient(90deg,#38bdf8,#8b5cf6,#7cff6b);
  transform:rotate(-14deg);
  box-shadow:0 0 14px rgba(124,255,107,.22);
}
.sv-action .path:before,.sv-action .path:after{
  content:"";position:absolute;width:7px;height:7px;border-radius:50%;top:-2px
}
.sv-action .path:before{left:0;background:#38bdf8;animation:glint 2.2s ease-in-out infinite}
.sv-action .path:after{right:0;background:#7cff6b;animation:glint 2.2s .5s ease-in-out infinite}
.sv-action .node{
  position:absolute;width:6px;height:6px;border-radius:50%;background:#fff;left:22px;top:16px;
  box-shadow:0 0 8px rgba(255,255,255,.7)
}

.product-top{
  align-items:flex-start;
}
.feature-visual{
  width:72px;height:72px;position:relative;overflow:hidden;
  border:1px solid rgba(255,255,255,.08);border-radius:18px;
  background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.015));
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.02);
}
.feature-visual::before{
  content:"";position:absolute;inset:-30%;
  background:linear-gradient(120deg,transparent 36%,rgba(255,255,255,.05) 50%,transparent 64%);
  transform:translateX(-120%);
  animation:signatureSweep 7s ease-in-out infinite;
}
.feature-visual span{
  position:absolute;display:block;
}
.fv-market .wave{
  left:10px;right:10px;height:2px;border-radius:999px;
  background:linear-gradient(90deg,#38bdf8,#8b5cf6,#7cff6b);
  box-shadow:0 0 12px rgba(124,255,107,.22);
}
.fv-market .w1{top:23px;transform:skewY(-10deg)}
.fv-market .w2{top:36px;transform:skewY(8deg);opacity:.7}
.fv-market .dot{
  width:8px;height:8px;border-radius:50%;background:#7cff6b;right:12px;top:19px;
  box-shadow:0 0 12px #7cff6b;animation:glint 2.1s infinite
}
.fv-market .gridline{
  left:12px;right:12px;height:1px;background:rgba(255,255,255,.06)
}
.fv-market .g1{bottom:18px}.fv-market .g2{bottom:28px}.fv-market .g3{bottom:38px}

.fv-wallet .node{
  width:8px;height:8px;border-radius:50%;background:#38bdf8;box-shadow:0 0 10px rgba(56,189,248,.45)
}
.fv-wallet .n1{left:15px;top:20px}
.fv-wallet .n2{right:15px;top:16px;background:#8b5cf6;box-shadow:0 0 10px rgba(139,92,246,.45)}
.fv-wallet .n3{left:22px;bottom:14px;background:#7cff6b;box-shadow:0 0 10px rgba(124,255,107,.45)}
.fv-wallet .n4{right:18px;bottom:18px;background:#fff;box-shadow:0 0 10px rgba(255,255,255,.45)}
.fv-wallet .link{
  height:1px;background:rgba(255,255,255,.22);transform-origin:left center
}
.fv-wallet .l1{left:22px;top:24px;width:30px;transform:rotate(-8deg)}
`;