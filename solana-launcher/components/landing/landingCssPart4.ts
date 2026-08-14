// Auto-generated from approved POTAPoff landing CSS.
export const LANDING_CSS_PART_4 = String.raw`.fv-wallet .l2{left:23px;top:28px;width:18px;transform:rotate(58deg)}
.fv-wallet .l3{left:31px;top:49px;width:24px;transform:rotate(-20deg)}

.fv-bundle .box{
  width:16px;height:16px;border-radius:6px;border:1px solid rgba(255,255,255,.18);
  background:rgba(255,255,255,.03)
}
.fv-bundle .b1{left:14px;top:14px}
.fv-bundle .b2{left:42px;top:14px}
.fv-bundle .b3{left:14px;top:42px}
.fv-bundle .b4{left:42px;top:42px}
.fv-bundle .join{
  background:linear-gradient(90deg,#38bdf8,#7cff6b);height:1px
}
.fv-bundle .j1{left:30px;top:22px;width:12px}
.fv-bundle .j2{left:22px;top:30px;width:1px;height:12px;background:linear-gradient(#8b5cf6,#7cff6b)}
.fv-bundle .j3{left:50px;top:30px;width:1px;height:12px;background:linear-gradient(#38bdf8,#8b5cf6)}
.fv-bundle .pulse{
  width:10px;height:10px;border-radius:50%;left:31px;top:31px;background:#7cff6b;
  box-shadow:0 0 14px #7cff6b;animation:ringTiny 1.8s infinite
}

.fv-launch .track{
  left:14px;right:14px;bottom:18px;height:2px;border-radius:99px;
  background:linear-gradient(90deg,#38bdf8,#8b5cf6,#7cff6b)
}
.fv-launch .rocket{
  width:14px;height:22px;left:28px;top:14px;
  border:1px solid rgba(255,255,255,.18);
  border-radius:10px 10px 6px 6px;
  background:linear-gradient(180deg,rgba(255,255,255,.14),rgba(255,255,255,.03));
  transform:rotate(18deg);
  animation:rocketLift 2.8s ease-in-out infinite;
}
.fv-launch .rocket::before{
  content:"";position:absolute;left:3px;right:3px;bottom:-7px;height:8px;
  background:radial-gradient(circle at 50% 0%, rgba(124,255,107,.9), rgba(124,255,107,0));
}
.fv-launch .trail{
  width:2px;height:18px;background:linear-gradient(#8b5cf6, transparent);
  left:35px;top:35px;transform:rotate(18deg)
}

.pipe-node{
  display:none;
}
.pipe-visual{
  width:54px;height:54px;position:relative;overflow:hidden;
  border:1px solid rgba(255,255,255,.08);border-radius:16px;
  background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.015));
}
.pipe-visual::before{
  content:"";position:absolute;inset:-35%;
  background:linear-gradient(120deg,transparent 36%,rgba(255,255,255,.05) 50%,transparent 64%);
  transform:translateX(-120%);
  animation:signatureSweep 7.5s ease-in-out infinite;
}
.pipe-visual .label{
  position:absolute;left:8px;top:7px;color:#566273;font-size:8px;font-weight:800;letter-spacing:.09em
}
.pv-detect .pulse{
  position:absolute;left:14px;right:14px;top:28px;height:2px;
  background:linear-gradient(90deg,#38bdf8,#7cff6b)
}
.pv-detect .pulse::after{
  content:"";position:absolute;right:0;top:-3px;width:8px;height:8px;border-radius:50%;
  background:#7cff6b;box-shadow:0 0 12px #7cff6b;animation:glint 2s infinite
}
.pv-verify .rings{
  position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:18px;height:18px;border:1px solid rgba(124,255,107,.25);border-radius:50%;
  animation:ringPulse 2.4s infinite
}
.pv-verify .rings::before,.pv-verify .rings::after{
  content:"";position:absolute;inset:4px;border:1px solid rgba(56,189,248,.26);border-radius:50%
}
.pv-connect .n{
  position:absolute;width:6px;height:6px;border-radius:50%;background:#8b5cf6
}
.pv-connect .n1{left:14px;top:18px}.pv-connect .n2{right:14px;top:15px;background:#38bdf8}.pv-connect .n3{left:23px;bottom:14px;background:#7cff6b}
.pv-connect .e{position:absolute;height:1px;background:rgba(255,255,255,.22)}
.pv-connect .e1{left:18px;top:21px;width:24px;transform:rotate(-8deg)}
.pv-connect .e2{left:19px;top:23px;width:16px;transform:rotate(58deg)}
.pv-act .arrow{
  position:absolute;left:12px;right:12px;top:28px;height:2px;background:linear-gradient(90deg,#38bdf8,#8b5cf6,#7cff6b)
}
.pv-act .arrow::after{
  content:"";position:absolute;right:-1px;top:-3px;border-left:8px solid #7cff6b;border-top:4px solid transparent;border-bottom:4px solid transparent
}

@keyframes signatureSweep{
  0%{transform:translateX(-120%)}
  55%,100%{transform:translateX(120%)}
}
@keyframes barPulse{
  50%{transform:translateY(-2px)}
}
@keyframes ringPulse{
  50%{transform:scale(1.16);opacity:.55}
}
@keyframes glint{
  50%{box-shadow:0 0 18px currentColor}
}
@keyframes rocketLift{
  50%{transform:rotate(18deg) translateY(-4px)}
}
@keyframes ringTiny{
  50%{transform:scale(1.18);opacity:.75}
}

@media(max-width:600px){
  .feature-visual{width:64px;height:64px}
}



/* Final preview fixes: logo + CTA + login modal only */
.brand-full-preview{display:inline-flex;align-items:center;flex:0 0 auto;line-height:0}
.brand-full-preview img{display:block;width:292px;height:58px;object-fit:contain;object-position:left center}
footer .brand-full-preview img{width:236px;height:56px}
.hero-actions .btn:not(.primary){white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;text-align:center;min-width:218px;padding-inline:22px}

/* Lock the selected V09 auth form so browser defaults can never leak through. */
.modal{position:fixed;inset:0;z-index:50;display:none;place-items:center;padding:18px;background:rgba(1,3,7,.82);backdrop-filter:blur(17px);-webkit-backdrop-filter:blur(17px)}
.modal:target,.modal.open{display:grid}
.login-card{position:relative;width:min(470px,calc(100vw - 28px));padding:0;overflow:hidden;border:1px solid rgba(255,255,255,.08);border-radius:28px;background:transparent;box-shadow:0 32px 100px -55px rgba(0,0,0,.98)}
.login-panel{position:relative;overflow:hidden;padding:26px;border-radius:28px;background:radial-gradient(circle at 18% 0%,rgba(139,92,246,.14),transparent 24%),radial-gradient(circle at 100% 100%,rgba(56,189,248,.12),transparent 28%),linear-gradient(180deg,#111827 0%,#0b1018 100%)}
.login-panel h3{position:relative;margin:16px 0 0;font-size:32px;line-height:1.02;letter-spacing:-.045em}
.login-sub{position:relative;margin:10px 0 0;color:#8a97aa;font-size:13px;line-height:1.55}
.login-fields{position:relative;display:grid;gap:12px;margin-top:18px}
.login-field{position:relative;height:50px;display:flex;align-items:center;gap:10px;padding:0 14px;border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.022);color:rgba(255,255,255,.34)}
.login-field:focus-within{border-color:rgba(124,255,107,.26);box-shadow:0 0 0 4px rgba(124,255,107,.055),0 0 18px rgba(124,255,107,.06);background:rgba(255,255,255,.03)}
.login-field i{width:18px;height:18px;display:grid;place-items:center;flex:0 0 auto;color:#8d9baf;font-style:normal;font-size:11px}
.login-field input{appearance:none;-webkit-appearance:none;width:100%;height:100%;margin:0;padding:0;border:0;outline:0;background:transparent;color:#f6f8fd;font:inherit;font-size:13px}
.login-field input::placeholder{color:rgba(255,255,255,.28)}
.login-actions{position:relative;display:grid;gap:10px;margin-top:16px}
.login-btn,.telegram-auth{position:relative;overflow:hidden;width:100%;min-height:50px;margin:0;border-radius:14px;box-sizing:border-box;text-decoration:none;font:inherit}
.login-btn{border:1px solid rgba(124,255,107,.30);background:linear-gradient(135deg,#8b5cf6 0%,#7cff6b 100%);color:#081008;font-size:14px;font-weight:900;letter-spacing:.02em;cursor:pointer}
.telegram-auth{display:flex;align-items:center;justify-content:center;gap:10px;padding:0 14px;border:1px solid rgba(56,189,248,.28);background:linear-gradient(180deg,rgba(56,189,248,.15),rgba(56,189,248,.08));color:#eefbff;font-size:13px;font-weight:850}
.tg-dot{position:relative;z-index:1;width:26px;height:26px;display:grid;place-items:center;flex:0 0 26px;border-radius:9px;background:#27a7e7;color:#fff;box-shadow:0 0 18px rgba(39,167,231,.28)}
.telegram-auth svg,.tg-dot svg{display:block!important;width:15px!important;height:15px!important;max-width:15px!important;max-height:15px!important;min-width:15px!important;min-height:15px!important;stroke:currentColor!important}
.telegram-auth>span:last-child{position:relative;z-index:1}
.login-helper{position:relative;margin-top:12px;color:rgba(255,255,255,.30);font-size:10px;text-align:center;line-height:1.45}
.close{position:absolute;right:16px;top:16px;z-index:3;width:38px;height:38px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.08);border-radius:12px;background:rgba(255,255,255,.03);color:rgba(255,255,255,.48);text-decoration:none}
@media(max-width:700px){
  .brand-full-preview img{width:202px;height:48px}
  footer .brand-full-preview img{width:194px;height:46px}
  .modal{align-items:end;padding:10px}
  .login-card{width:100%;border-radius:24px}
  .login-panel{padding:20px;border-radius:24px}
  .login-panel h3{font-size:28px}
  .hero-actions .btn:not(.primary){min-width:0;width:100%}
}



/* Larger navigation + working Normal/Gold theme */
header{height:94px;background:rgba(5,7,11,.84);backdrop-filter:blur(24px) saturate(145%)}
.header{gap:30px}
.brand-full-preview img{width:304px!important;height:62px!important}
nav{gap:32px!important;font-size:14px!important;font-weight:680}
nav a{padding:15px 0;color:rgba(255,255,255,.64)}
.header-actions{gap:11px!important}
.header-actions .btn,.lang{height:46px!important}
.header-actions .btn{padding-inline:18px!important;border-radius:13px!important}
.lang{padding-inline:13px!important}
.theme-switch-preview{height:46px;display:inline-flex;align-items:center;gap:4px;padding:4px;border:1px solid rgba(255,255,255,.09);border-radius:14px;background:rgba(255,255,255,.04)}
.theme-preview-option{height:36px;padding:0 12px;border:1px solid transparent;border-radius:10px;background:transparent;color:rgba(255,255,255,.42);font:850 9px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;cursor:pointer;transition:.22s ease}
.theme-preview-option:hover{color:#fff}
.theme-preview-option.active{border-color:rgba(124,255,107,.28);background:rgba(124,255,107,.09);color:#7cff6b}

body.gold-theme-preview{
  --bg:#100a04;--bg2:#171006;--panel:#181007;--panel2:#211607;
  --line:rgba(242,190,83,.10);--line2:rgba(242,190,83,.18);
  --green:#f2be53;--green2:#ffd984;--green-soft:rgba(242,190,83,.11);
  --purple:#c78b33;--blue:#f4d58d;
  background:radial-gradient(circle at 10% 12%,rgba(242,190,83,.11),transparent 28rem),radial-gradient(circle at 87% 32%,rgba(177,114,22,.11),transparent 32rem),linear-gradient(180deg,#0b0703,#100a04 45%,#120c05 100%);
}
body.gold-theme-preview header{background:rgba(16,10,4,.88);border-bottom-color:rgba(242,190,83,.12)}
body.gold-theme-preview .theme-switch-preview{border-color:rgba(242,190,83,.16);background:rgba(242,190,83,.045)}
body.gold-theme-preview .theme-preview-option.active{border-color:rgba(242,190,83,.36);background:rgba(242,190,83,.12);color:#f2be53}
body.gold-theme-preview .btn.primary{background:linear-gradient(135deg,#f2be53,#ffe09a);color:#1a1003;border-color:rgba(242,190,83,.42);box-shadow:0 18px 50px -28px rgba(242,190,83,.75)}
body.gold-theme-preview .eyebrow{border-color:rgba(242,190,83,.28)}
body.gold-theme-preview h1 span{background:linear-gradient(95deg,#fff 5%,#ffe3a6 45%,#f2be53 92%);background-clip:text;-webkit-background-clip:text}
body.gold-theme-preview .terminal,body.gold-theme-preview .product-card,body.gold-theme-preview .pipe-card,body.gold-theme-preview .social-engine,body.gold-theme-preview .app-shell{border-color:rgba(242,190,83,.13)}
body.gold-theme-preview .workspace{background:linear-gradient(180deg,rgba(242,190,83,.018),rgba(177,114,22,.035))}
body.gold-theme-preview .cta{border-color:rgba(242,190,83,.24);background:linear-gradient(135deg,rgba(242,190,83,.11),rgba(177,114,22,.035) 48%,rgba(242,190,83,.07))}

@media(max-width:1180px){header{height:86px}.brand-full-preview img{width:252px!important;height:54px!important}nav{gap:20px!important;font-size:12px!important}.theme-preview-option{padding-inline:9px}}
@media(max-width:980px){header{height:76px}.brand-full-preview img{width:210px!important;height:48px!important}.theme-switch-preview{height:42px}.theme-preview-option{height:32px}.header-actions .btn,.lang{height:42px!important}}
@media(max-width:700px){.brand-full-preview img{width:196px!important;height:46px!important}.theme-switch-preview{display:none}}

/* Production behavior states */
.login-status {
  display: none;
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 11px;
  font-size: 11px;
  line-height: 1.45;
}
.login-status.show { display: block; }
.login-status.error {
  border: 1px solid rgba(255, 83, 110, .28);
  background: rgba(255, 83, 110, .07);
  color: #ffb5c1;
}
.login-status.success {
  border: 1px solid rgba(124, 255, 107, .26);
  background: rgba(124, 255, 107, .07);
  color: #baffb0;
}
.login-btn:disabled { opacity: .62; cursor: wait; }
.market-data-error {
  display: none;
  margin-top: 8px;
  color: #ff9cab;
  font: 700 9px ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .04em;
}
.market-data-error.show { display: block; }
`;