// Auto-generated from approved POTAPoff landing CSS.
export const LANDING_CSS_PART_2 = String.raw`.modal{position:fixed;inset:0;z-index:50;display:none;place-items:center;padding:18px;background:rgba(1,3,7,.82);backdrop-filter:blur(17px)}.modal.open,.modal:target{display:grid}.login-card{width:min(500px,100%);position:relative;padding:24px;border:1px solid var(--line2);border-radius:24px;background:linear-gradient(160deg,#111823,#080c12);box-shadow:0 40px 120px rgba(0,0,0,.65)}.close{position:absolute;right:14px;top:14px;width:36px;height:36px;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.03);color:#8591a3;font-size:18px}.auth-badge{display:inline-flex;padding:6px 9px;border:1px solid rgba(124,255,107,.22);border-radius:999px;background:var(--green-soft);color:var(--green);font-size:8px;font-weight:850;letter-spacing:.12em}.login-card h3{font-size:29px;letter-spacing:-.04em;margin:15px 0 7px}.login-card>p{color:#8c98aa;font-size:13px;line-height:1.6;margin:0}.telegram{width:100%;height:53px;margin-top:20px;border:1px solid rgba(56,189,248,.34);border-radius:14px;background:linear-gradient(90deg,rgba(56,189,248,.14),rgba(124,255,107,.07));color:#f2fbff;font-weight:850}.telegram strong{color:#67d0ff}.auth-status{display:none;margin-top:12px;padding:10px;border:1px solid rgba(124,255,107,.18);border-radius:10px;background:var(--green-soft);color:#baf8b2;font-size:10px;line-height:1.5}.auth-status.show{display:block}.divider{display:flex;align-items:center;gap:10px;margin:17px 0;color:#566276;font-size:8px}.divider:before,.divider:after{content:"";height:1px;background:var(--line);flex:1}.alt-login{width:100%;height:43px;border:1px solid var(--line);border-radius:11px;background:rgba(255,255,255,.02);color:#909cad;font-weight:700}.legacy{display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}.legacy.open{display:grid;gap:9px}.legacy input{width:100%;height:42px;border:1px solid var(--line);border-radius:10px;background:#070a10;color:#fff;padding:0 11px;outline:none}.legacy input:focus{border-color:rgba(124,255,107,.28)}.legacy button{height:43px;border:0;border-radius:10px;background:var(--green);color:#061006;font-weight:850}
.preview-note{position:fixed;right:12px;bottom:12px;z-index:60;padding:7px 10px;border:1px solid var(--line);border-radius:9px;background:rgba(5,7,11,.78);backdrop-filter:blur(12px);color:#586577;font-size:8px}

@media(max-width:980px){nav{display:none}.hero,.workspace-layout{grid-template-columns:1fr}.hero{padding-top:46px}.market-shell{max-width:820px}.product-grid{grid-template-columns:1fr}.app-main{grid-template-columns:120px 1fr}}
@media(max-width:700px){.wrap{width:min(100% - 24px,var(--max))}.lang{display:none}.hero{min-height:auto}.market-metrics{grid-template-columns:repeat(2,1fr)}.fc1,.fc2{display:none}.strip-grid{grid-template-columns:1fr}.strip-item:not(:last-child){border-right:0;border-bottom:1px solid var(--line)}.strip-item:not(:first-child){padding-left:0}.section{padding:78px 0}.workspace-layout{gap:28px}.app-main{grid-template-columns:1fr}.sidebar{display:none}.dash-grid{grid-template-columns:1fr}.cta{align-items:flex-start;flex-direction:column;padding:29px}.footer{align-items:flex-start;flex-direction:column}.header-actions .btn:first-of-type{display:none}}
@media(max-width:480px){h1{font-size:48px}.hero-actions .btn{width:100%}.price-row{align-items:flex-start;flex-direction:column}.chart{height:250px}.market-metrics{grid-template-columns:1fr}.dash-cards{grid-template-columns:1fr}.market{padding:14px}.login-card{padding:20px}}



/* Login modal V2 */
.modal {
  align-items: center;
  justify-items: center;
  padding: 20px;
  background: rgba(2,4,8,.76);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.login-card {
  width: min(440px, 100%);
  padding: 0;
  overflow: hidden;
  border-radius: 22px;
  border: 1px solid rgba(255,255,255,.10);
  background:
    radial-gradient(circle at 90% 0%, rgba(124,255,107,.08), transparent 32%),
    linear-gradient(180deg, #0d121b 0%, #090d14 100%);
  box-shadow: 0 28px 80px rgba(0,0,0,.55);
}
.login-card-inner { padding: 24px; }
.close {
  top: 16px; right: 16px;
  width: 36px; height: 36px;
  border-radius: 11px;
  background: rgba(255,255,255,.025);
  color: rgba(255,255,255,.48);
}
.auth-badge {
  padding: 6px 9px;
  font-size: 8px;
  letter-spacing: .12em;
}
.login-card h3 {
  margin: 17px 44px 0 0;
  font-size: 28px;
  line-height: 1.05;
  letter-spacing: -.035em;
}
.login-card .login-sub {
  margin: 10px 0 0;
  color: rgba(255,255,255,.48);
  font-size: 13px;
  line-height: 1.55;
}
.telegram-auth {
  margin-top: 22px;
  width: 100%;
  min-height: 54px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 11px;
  border: 1px solid rgba(56,189,248,.30);
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(56,189,248,.15), rgba(56,189,248,.08));
  color: #effbff;
  font-size: 14px;
  font-weight: 850;
  text-align: center;
}
.telegram-auth:hover { border-color: rgba(56,189,248,.50); }
.telegram-auth .tg-icon {
  width: 28px; height: 28px;
  display: grid; place-items: center;
  flex: 0 0 auto;
  border-radius: 9px;
  background: #27a7e7;
  color: white;
}
.telegram-auth svg { width: 16px; height: 16px; }
.telegram-auth .tg-copy { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
.auth-helper {
  margin-top: 11px;
  color: rgba(255,255,255,.32);
  font-size: 10px;
  line-height: 1.45;
  text-align: center;
}
.auth-status {
  margin-top: 12px;
  border-radius: 11px;
  font-size: 10px;
}
.divider {
  margin: 18px 0 12px;
  color: rgba(255,255,255,.25);
}
.alt-login {
  height: 42px;
  border-radius: 11px;
  color: rgba(255,255,255,.56);
  font-size: 12px;
  background: rgba(255,255,255,.018);
}
.legacy {
  margin-top: 12px;
  padding-top: 12px;
}
.legacy input {
  height: 44px;
}
.login-security {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-top: 16px;
  color: rgba(255,255,255,.24);
  font-size: 9px;
}
.login-security i {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: #7cff6b;
  box-shadow: 0 0 8px #7cff6b;
}
@media(max-width:600px){
  .modal {
    align-items: end;
    padding: 10px;
  }
  .login-card {
    width: 100%;
    border-radius: 22px 22px 18px 18px;
    max-height: calc(100dvh - 18px);
    overflow-y: auto;
  }
  .login-card-inner { padding: 22px 18px 20px; }
  .login-card h3 { font-size: 27px; margin-top: 15px; }
  .login-card .login-sub { font-size: 13px; }
  .telegram-auth {
    min-height: 56px;
    font-size: 14px;
  }
  .telegram-auth .tg-copy { white-space: normal; justify-content: center; }
}



/* Integrated login modal: V09 animated */
.modal{
  position:fixed;inset:0;z-index:50;display:none;place-items:center;
  padding:18px;background:rgba(2,4,8,.78);
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
}
.modal.open,.modal:target{display:grid}

.login-card{
  position:relative;
  width:min(470px,100%);
  padding:0;
  overflow:hidden;
  border-radius:28px;
  border:1px solid rgba(255,255,255,.07);
  background:transparent;
  box-shadow:0 32px 100px -55px rgba(0,0,0,.98);
}
.login-card::before{
  content:"";
  position:absolute;inset:-1px;border-radius:28px;padding:1px;
  background:linear-gradient(135deg, rgba(139,92,246,.55), rgba(56,189,248,.34), rgba(124,255,107,.48), rgba(139,92,246,.55));
  background-size:220% 220%;
  animation:loginBorderFlow 8s linear infinite;
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite:xor; mask-composite:exclude;
  pointer-events:none;
}
.login-card::after{
  content:"";
  position:absolute;inset:12% -12% -8% 12%;z-index:-1;border-radius:50%;
  background:radial-gradient(circle, rgba(139,92,246,.16), rgba(56,189,248,.08) 36%, rgba(124,255,107,.08) 55%, transparent 72%);
  filter:blur(42px);
  animation:loginGlowPulse 4.5s ease-in-out infinite;
}
.login-panel{
  position:relative;
  overflow:hidden;
  border-radius:28px;
  background:
    radial-gradient(circle at 18% 0%, rgba(139,92,246,.14), transparent 24%),
    radial-gradient(circle at 100% 100%, rgba(56,189,248,.12), transparent 28%),
    linear-gradient(180deg, #111827 0%, #0b1018 100%);
  padding:26px;
  animation:loginSoftTilt 7.5s ease-in-out infinite;
}
.login-panel::before{
  content:"";
  position:absolute;inset:-20%;
  background:linear-gradient(110deg, transparent 35%, rgba(255,255,255,.06) 50%, transparent 65%);
  transform:translateX(-120%) rotate(8deg);
  animation:loginSweep 5s ease-in-out infinite;
  pointer-events:none;
}
.close{
  position:absolute;right:16px;top:16px;z-index:2;
  width:38px;height:38px;border-radius:12px;
  border:1px solid rgba(255,255,255,.08);
  background:rgba(255,255,255,.03);
  color:rgba(255,255,255,.48);
  display:grid;place-items:center;text-decoration:none;
  transition:transform .2s ease,border-color .2s ease,background .2s ease;
}
.close:hover{transform:translateY(-1px);border-color:rgba(255,255,255,.14);background:rgba(255,255,255,.045)}
.auth-badge{
  position:relative;
  display:inline-flex;padding:6px 10px;border-radius:999px;
  border:1px solid rgba(255,255,255,.10);
  background:rgba(255,255,255,.04);
  color:#eff2f8;font-size:8px;font-weight:850;letter-spacing:.15em;text-transform:uppercase;
}
.login-panel h3{
  position:relative;margin:16px 0 0;
  font-size:32px;line-height:1.02;letter-spacing:-.045em;
}
.login-sub{
  position:relative;
  margin:10px 0 0;color:#8a97aa;font-size:13px;line-height:1.55;
}

.login-fields{position:relative;display:grid;gap:12px;margin-top:18px}
.login-field{
  position:relative;
  height:50px;display:flex;align-items:center;gap:10px;
  padding:0 14px;border:1px solid rgba(255,255,255,.08);border-radius:14px;
  background:rgba(255,255,255,.022);color:rgba(255,255,255,.34);
  transition:transform .22s ease,border-color .22s ease, box-shadow .22s ease, background .22s ease;
}
.login-field:hover{transform:translateY(-1px);border-color:rgba(255,255,255,.13)}
.login-field:focus-within{
  border-color:rgba(124,255,107,.26);
  box-shadow:0 0 0 4px rgba(124,255,107,.055), 0 0 18px rgba(124,255,107,.06);
  background:rgba(255,255,255,.03);
}
.login-field i{
  width:18px;height:18px;display:grid;place-items:center;flex:0 0 auto;
  color:#8d9baf;font-style:normal;font-size:11px
}
.login-field input{
  width:100%;height:100%;border:0;outline:0;background:transparent;
  color:#f6f8fd;font-size:13px;
}
.login-field input::placeholder{color:rgba(255,255,255,.28)}

.login-actions{position:relative;display:grid;gap:10px;margin-top:16px}
.login-btn,
.telegram-auth{
  position:relative;overflow:hidden;
  min-height:50px;border:1px solid rgba(255,255,255,.08);border-radius:14px;
  transition:transform .22s ease, box-shadow .22s ease, border-color .22s ease;
}
.login-btn:hover,.telegram-auth:hover{transform:translateY(-1px)}
.login-btn:active,.telegram-auth:active{transform:translateY(0) scale(.995)}
.login-btn{
  background:linear-gradient(135deg, #8b5cf6 0%, #7cff6b 100%);
  color:#081008;font-size:14px;font-weight:900;letter-spacing:.02em;
  box-shadow:0 20px 50px -24px rgba(139,92,246,.45), 0 14px 35px -22px rgba(124,255,107,.5);
  animation:loginCtaPulse 3.2s ease-in-out infinite;
}
.login-btn::before{
  content:"";
  position:absolute;inset:0;
  background:linear-gradient(110deg, transparent 30%, rgba(255,255,255,.22) 50%, transparent 70%);
  transform:translateX(-120%);
  animation:loginSweep 3.7s ease-in-out infinite;
}
.login-btn span{position:relative;z-index:1}
.telegram-auth{
  display:flex;align-items:center;justify-content:center;gap:10px;
  background:linear-gradient(180deg, rgba(56,189,248,.15), rgba(56,189,248,.08));
  border-color:rgba(56,189,248,.28);
  color:#eefbff;font-size:13px;font-weight:850;
  text-decoration:none;
}
.telegram-auth::before{
  content:"";
  position:absolute;left:-120%;top:0;bottom:0;width:60%;
  background:linear-gradient(100deg, transparent, rgba(255,255,255,.13), transparent);
  animation:loginScan 2.8s linear infinite;
}
.telegram-auth:hover{box-shadow:0 0 0 1px rgba(56,189,248,.12), 0 14px 30px -20px rgba(56,189,248,.35)}
.tg-dot{
  position:relative;z-index:1;
  width:26px;height:26px;border-radius:9px;display:grid;place-items:center;
  background:#27a7e7;color:white;flex:0 0 auto;
  box-shadow:0 0 18px rgba(39,167,231,.28);
}
.tg-dot svg{width:15px;height:15px;display:block}
.telegram-auth span:last-child{position:relative;z-index:1}

.login-helper{
  position:relative;margin-top:12px;color:rgba(255,255,255,.30);
  font-size:10px;text-align:center;line-height:1.45;
}

.legacy-divider{
  margin:15px 0 10px;
  display:flex;align-items:center;gap:10px;
  color:rgba(255,255,255,.24);font-size:10px;text-transform:lowercase;
}
.legacy-divider::before,.legacy-divider::after{
  content:"";flex:1;height:1px;background:rgba(255,255,255,.08);
}
.alt-login{
  width:100%;height:44px;border-radius:12px;
  border:1px solid rgba(255,255,255,.08);
  background:rgba(255,255,255,.018);
  color:rgba(255,255,255,.56);font-size:12px;font-weight:750;
}
.legacy{
  margin-top:12px;padding-top:12px;display:none;gap:10px;
}
.legacy.open{display:grid}
.legacy input{
  width:100%;height:44px;padding:0 13px;border-radius:12px;
  border:1px solid rgba(255,255,255,.08);
  background:rgba(255,255,255,.022);color:#fff;outline:none;
}
.legacy input::placeholder{color:rgba(255,255,255,.26)}
.legacy button{
  height:44px;border-radius:12px;border:1px solid rgba(124,255,107,.28);
  background:rgba(124,255,107,.10);color:#9af58f;font-weight:800;
}

@keyframes loginBorderFlow{
  0%{background-position:0% 50%}
  100%{background-position:220% 50%}
}
@keyframes loginGlowPulse{
  50%{transform:scale(1.06);opacity:.75}
}
@keyframes loginSoftTilt{
  0%,100%{transform:rotate(-.2deg) translateY(0)}
  25%{transform:rotate(.18deg) translateY(-2px)}
  50%{transform:rotate(-.14deg) translateY(2px)}
  75%{transform:rotate(.12deg) translateY(-1px)}
}
@keyframes loginSweep{
`;